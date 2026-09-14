import type { ServerMessage } from "../shared/protocol.js";
import { Microphone } from "./audio/mic.js";
import { VoicePlayer, primeVoices } from "./audio/player.js";
import { BrowserRecognizer } from "./audio/recognizer.js";
import { log } from "./log.js";
import { DaemonLink, postAudio } from "./net.js";
import { Cockpit } from "./ui.js";

declare const __VERSION__: string;

/**
 * The cockpit: the duplex loop that runs inside OpenCode Web.
 *
 * It owns the microphone, the voice, and the link to the daemon, and it makes
 * exactly one class of decision — the one that must happen in under a tenth of
 * a second, locally: when the user starts talking over the agent, cut the
 * audio now. Everything else (is this noise, what did they mean, should the
 * agent be interrupted) travels to the streamer, because those are judgements.
 *
 * Transcription takes whichever path is available: the daemon's endpoint when
 * it has one, the browser's recognizer otherwise, each feeding the same
 * pipeline.
 */

const STATE_KEY = "__opencodeWebStream";
const LANG_KEY = "opencodeWebStream.lang";
const LIVE_KEY = "opencodeWebStream.live";
const MUTE_KEY = "opencodeWebStream.muted";
/** A barge-in with no words behind it: resume rather than sit in silence. */
const FALSE_BARGE_IN_MS = 2200;

type Global = typeof globalThis & {
  [STATE_KEY]?: { destroy: () => void; logs: () => unknown[]; version: string };
};

class CockpitApp {
  private readonly link: DaemonLink;
  private readonly player: VoicePlayer;
  private readonly ui: Cockpit;
  private mic?: Microphone;
  private recognizer?: BrowserRecognizer;
  private sessionID = "";
  private live = false;
  private muted = readFlag(MUTE_KEY, false);
  private digest = false;
  private serverEars = false;
  private serverVoice = false;
  private unlocked = false;
  private speakingUtterance?: string;
  private interruptedAt = 0;
  private interruptedHeard = "";
  private falseBargeTimer?: number;
  private pendingTranscripts = new Set<AbortController>();
  private lang = readString(LANG_KEY, navigator.language?.startsWith("en") ? "en-US" : "fr-FR");
  private destroyed = false;

  constructor() {
    this.ui = new Cockpit({
      onToggleLive: () => void this.toggleLive(),
      onToggleMute: () => this.toggleMute(),
      onCancelInject: (injectId) => this.link.send({ type: "cancel_inject", sessionID: this.sessionID, injectId }),
      onStop: () => {
        this.player.cancel();
        this.link.send({ type: "control", sessionID: this.sessionID, action: "stop" });
      },
      onRepeat: () => {
        if (!this.player.repeat()) this.link.send({ type: "control", sessionID: this.sessionID, action: "repeat" });
      },
      onToggleDigest: () => {
        this.digest = !this.digest;
        this.link.send({ type: "prefs", sessionID: this.sessionID, digest: this.digest });
        this.ui.update({ digest: this.digest });
      },
    });

    this.player = new VoicePlayer(
      { serverAvailable: () => this.serverVoice, lang: this.lang },
      {
        onStart: (utterance) => {
          this.speakingUtterance = utterance.id;
          this.mic?.setDucked(true);
          this.ui.showSaying(utterance.text);
          this.ui.update({ state: "speaking" });
        },
        onEnd: (utterance, completed, heardText) => {
          this.speakingUtterance = undefined;
          this.link.send({ type: "spoken", sessionID: this.sessionID, utteranceId: utterance.id, completed, heardText: completed ? undefined : heardText });
        },
        onIdle: () => {
          this.mic?.setDucked(false);
          this.ui.showSaying(undefined);
        },
        onError: (err) => log.warn("player error", err),
      },
    );

    this.link = new DaemonLink({
      onMessage: (msg) => this.onServerMessage(msg),
      onOpen: () => {
        this.ui.update({ connected: true });
        this.link.attach(this.sessionID, undefined, !document.hidden);
        if (this.live) this.link.send({ type: "live", sessionID: this.sessionID, enabled: true });
      },
      onClose: () => this.ui.update({ connected: false }),
    });
  }

  async start() {
    primeVoices();
    this.sessionID = sessionIdFromLocation();
    this.ui.mount();
    this.ui.update({ muted: this.muted, state: "idle" });
    this.link.open();
    void this.refreshStatus();

    // Audio needs a gesture; take the first one the page gets.
    const unlock = () => void this.unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });

    window.addEventListener("visibilitychange", () => {
      this.link.send({ type: "visible", sessionID: this.sessionID, visible: !document.hidden });
    });

    // The app is a SPA: follow the session in the URL without a reload.
    window.addEventListener("popstate", () => this.syncSession());
    const historyPush = history.pushState.bind(history);
    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      historyPush(...args);
      queueMicrotask(() => this.syncSession());
    };
    window.setInterval(() => this.syncSession(), 1500);

    if (readFlag(LIVE_KEY, false)) {
      log.info("restoring live mode");
      await this.toggleLive(true);
    }
  }

  private syncSession() {
    const next = sessionIdFromLocation();
    if (!next || next === this.sessionID) return;
    log.info("session changed", { from: this.sessionID, to: next });
    const wasLive = this.live;
    if (wasLive) void this.stopListening();
    this.link.send({ type: "detach", sessionID: this.sessionID });
    this.player.cancel();
    this.sessionID = next;
    this.link.attach(next, undefined, !document.hidden);
    if (wasLive) void this.toggleLive(true);
  }

  private async refreshStatus() {
    try {
      const res = await fetch(DaemonLink.apiUrl("/api/status"));
      if (!res.ok) return;
      const status = (await res.json()) as { tts: { ready: boolean }; stt: { ready: boolean } };
      this.serverVoice = status.tts.ready;
      this.serverEars = status.stt.ready;
      this.ui.update({ serverVoice: this.serverVoice, serverEars: this.serverEars });
    } catch {
      // The websocket carries status too; this is only a faster first read.
    }
  }

  private async unlockAudio() {
    if (this.unlocked) return;
    this.unlocked = true;
    const reference = await this.player.unlock();
    this.mic?.setReferenceStream(reference);
    log.debug("audio unlocked", { hasReference: Boolean(reference) });
  }

  // ---- live mode ----------------------------------------------------------

  private async toggleLive(force?: boolean) {
    const next = force ?? !this.live;
    if (next === this.live) return;
    this.live = next;
    writeFlag(LIVE_KEY, next);
    this.ui.update({ live: next, state: next ? "listening" : "idle" });
    this.link.send({ type: "live", sessionID: this.sessionID, enabled: next });
    if (next) {
      await this.unlockAudio();
      await this.startListening();
    } else {
      await this.stopListening();
      this.player.cancel();
    }
  }

  private toggleMute() {
    this.muted = !this.muted;
    writeFlag(MUTE_KEY, this.muted);
    if (this.muted) this.player.cancel();
    this.link.send({ type: "prefs", sessionID: this.sessionID, muted: this.muted });
    this.ui.update({ muted: this.muted });
  }

  private async startListening() {
    await this.refreshStatus();
    const reference = await this.player.unlock();
    this.mic = new Microphone(
      { referenceStream: reference },
      {
        onSpeechStart: () => {
          // Energy alone is not a decision; only duck the meter.
          this.ui.update({ state: this.player.isPlaying ? "speaking" : "listening" });
        },
        onSpeechConfirmed: () => this.onBargeIn(),
        onUtterance: (blob, meta) => void this.onUtterance(blob, meta),
        onSilence: () => {
          if (!this.player.isPlaying) this.ui.update({ state: "listening" });
        },
        onLevel: (level) => this.ui.setLevel(level),
        onError: (err) => log.warn("microphone error", err),
      },
    );
    try {
      await this.mic.start();
    } catch {
      this.mic = undefined;
    }
    // The browser recognizer is the transcription path when the daemon has none.
    if (!this.serverEars && BrowserRecognizer.supported) {
      this.recognizer = new BrowserRecognizer({
        onFinal: (text) => void this.submitTranscript(text, this.consumeBargeIn()),
        onInterim: (text) => this.ui.showInterim(text),
        onError: (error) => log.debug("recognizer", error),
      });
      this.recognizer.setLang(this.lang);
      await this.recognizer.prepareOnDevice();
      this.recognizer.start();
      log.info("using browser recognition", { biasing: this.recognizer.supportsBiasing, onDevice: this.recognizer.supportsOnDevice });
    } else {
      log.info("using daemon transcription");
    }
  }

  private async stopListening() {
    this.recognizer?.stop();
    this.recognizer = undefined;
    await this.mic?.stop();
    this.mic = undefined;
    for (const controller of this.pendingTranscripts) controller.abort();
    this.pendingTranscripts.clear();
    this.ui.setLevel(0);
  }

  /**
   * The one local decision: the user is talking over us, so stop the audio
   * immediately. What they meant is the streamer's problem, not ours.
   */
  private onBargeIn() {
    if (!this.player.isPlaying) return;
    const heard = this.player.interrupt();
    this.interruptedAt = Date.now();
    this.interruptedHeard = heard;
    this.mic?.setDucked(false);
    this.ui.update({ state: "interrupted" });
    this.link.send({ type: "barge_in", sessionID: this.sessionID, spokenOver: heard });
    // If no words follow, this was a cough or a side remark: pick up where we stopped.
    if (this.falseBargeTimer) window.clearTimeout(this.falseBargeTimer);
    this.falseBargeTimer = window.setTimeout(() => {
      this.falseBargeTimer = undefined;
      if (this.interruptedAt === 0) return;
      log.debug("false barge-in, resuming");
      this.interruptedAt = 0;
      this.link.send({ type: "barge_in_false", sessionID: this.sessionID });
      this.player.resume();
      this.ui.update({ state: "speaking" });
    }, FALSE_BARGE_IN_MS);
  }

  private consumeBargeIn(): { bargeIn: boolean; spokenOver?: string } {
    if (!this.interruptedAt) return { bargeIn: false };
    const spokenOver = this.interruptedHeard;
    this.interruptedAt = 0;
    this.interruptedHeard = "";
    if (this.falseBargeTimer) window.clearTimeout(this.falseBargeTimer);
    this.falseBargeTimer = undefined;
    return { bargeIn: true, spokenOver };
  }

  private async onUtterance(blob: Blob, meta: { durationMs: number; startedDuringPlayback: boolean }) {
    // With the browser recognizer running, audio segmentation is only used for
    // barge-in timing; the transcript comes from the recognizer itself.
    if (!this.serverEars) return;
    const context = this.consumeBargeIn();
    const bargeIn = context.bargeIn || meta.startedDuringPlayback;
    const controller = new AbortController();
    this.pendingTranscripts.add(controller);
    this.ui.update({ state: "thinking" });
    try {
      const result = await postAudio(
        blob,
        { sessionID: this.sessionID, lang: this.lang, bargeIn, spokenOver: context.spokenOver, apply: true },
        controller.signal,
      );
      if (!result.text) {
        log.debug("empty transcript");
        if (bargeIn) this.player.resume();
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.warn("transcription failed", err);
        this.serverEars = false;
        this.ui.update({ serverEars: false });
        // Fall back to the browser recognizer for the rest of the session.
        if (!this.recognizer && BrowserRecognizer.supported && this.live) await this.startBrowserRecognition();
      }
    } finally {
      this.pendingTranscripts.delete(controller);
    }
  }

  private async startBrowserRecognition() {
    this.recognizer = new BrowserRecognizer({
      onFinal: (text) => void this.submitTranscript(text, this.consumeBargeIn()),
      onInterim: (text) => this.ui.showInterim(text),
      onError: (error) => log.debug("recognizer", error),
    });
    this.recognizer.setLang(this.lang);
    await this.recognizer.prepareOnDevice();
    this.recognizer.start();
    log.info("switched to browser recognition");
  }

  private async submitTranscript(text: string, context: { bargeIn: boolean; spokenOver?: string }) {
    if (!text.trim() || !this.live) return;
    this.ui.update({ state: "thinking" });
    this.link.send({
      type: "transcript",
      sessionID: this.sessionID,
      text,
      bargeIn: context.bargeIn,
      spokenOver: context.spokenOver,
      lang: this.lang,
    });
  }

  // ---- daemon messages ----------------------------------------------------

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "hello":
      case "status": {
        this.serverVoice = msg.status.tts.ready;
        this.serverEars = msg.status.stt.ready;
        this.ui.update({ connected: msg.status.opencode.connected, serverVoice: this.serverVoice, serverEars: this.serverEars });
        return;
      }
      case "state": {
        if (msg.sessionID !== this.sessionID) return;
        this.ui.update({ state: msg.state });
        return;
      }
      case "speak": {
        if (this.muted && msg.utterance.kind !== "blocked") return;
        this.player.enqueue(msg.utterance);
        return;
      }
      case "cancel": {
        this.player.cancel({ utteranceId: msg.utteranceId, streamId: msg.streamId });
        return;
      }
      case "resume": {
        this.player.resume();
        return;
      }
      case "heard": {
        this.ui.showHeard(msg.raw, msg.corrected, msg.decision);
        return;
      }
      case "inject_pending": {
        this.ui.showInject(msg.injectId, msg.text, msg.mode, msg.executeAt);
        return;
      }
      case "inject_done": {
        this.ui.hideInject(msg.ok ? undefined : msg.error === "cancelled" ? "annulé" : `échec: ${msg.error ?? ""}`);
        return;
      }
      case "lexicon": {
        this.recognizer?.setPhrases(msg.phrases);
        log.debug("lexicon received", { terms: msg.phrases.length });
        return;
      }
      case "control": {
        this.applyControl(msg.action);
        return;
      }
      case "error": {
        log.warn("daemon error", msg.message);
        return;
      }
      default:
        return;
    }
  }

  private applyControl(action: string) {
    switch (action) {
      case "mute":
        this.muted = true;
        writeFlag(MUTE_KEY, true);
        this.player.cancel();
        this.ui.update({ muted: true });
        return;
      case "unmute":
        this.muted = false;
        writeFlag(MUTE_KEY, false);
        this.ui.update({ muted: false });
        return;
      case "stop":
        this.player.cancel();
        return;
      case "slower":
        this.player.setRate(0.85);
        return;
      case "faster":
        this.player.setRate(1.2);
        return;
      case "digest":
        this.digest = true;
        this.ui.update({ digest: true });
        return;
      case "full":
        this.digest = false;
        this.ui.update({ digest: false });
        return;
      default:
        return;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.stopListening();
    this.player.destroy();
    this.link.close();
    this.ui.destroy();
  }
}

/** OpenCode Web routes are `/:dir/session/:id` and `/session/:id`. */
export function sessionIdFromLocation(pathname = location.pathname): string {
  const match = pathname.match(/\/session\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // storage blocked: the preference lives for this page only
  }
}

function readString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

const scope = globalThis as Global;
scope[STATE_KEY]?.destroy();
const app = new CockpitApp();
scope[STATE_KEY] = { destroy: () => app.destroy(), logs: () => log.records(), version: typeof __VERSION__ === "string" ? __VERSION__ : "dev" };
void app.start();
