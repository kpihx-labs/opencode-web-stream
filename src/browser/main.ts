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
/**
 * The opencode-web-voice plugin, when installed alongside, has its own
 * language selector. Honouring it means one switch for both plugins.
 */
const VOICE_PLUGIN_LANG_KEY = "opencodeWebVoiceLang";
const VOICE_PLUGIN_SELECT = "select.opencode-web-voice-plugin-lang-select";
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
  /** The workspace in the URL. Known even on the new-session page, which is what lets the daemon create a session there. */
  private directory = "";
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
  /** "fr-FR", "en-US", … or "auto". */
  private lang = resolveLanguagePreference();
  /** Two-letter codes the daemon is configured for; the chip cycles through these plus "auto". */
  private languages: string[] = ["fr", "en"];
  private voicePluginSelect?: HTMLSelectElement;
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
      onCycleLang: () => this.cycleLanguage(),
    });

    this.player = new VoicePlayer(
      { serverAvailable: () => this.serverVoice, lang: this.recognizerLang() },
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
        this.link.attach(this.sessionID, this.directory, !document.hidden);
        if (this.live) this.link.send({ type: "live", sessionID: this.sessionID, enabled: true });
      },
      onClose: () => this.ui.update({ connected: false }),
    });
  }

  async start() {
    primeVoices();
    this.sessionID = sessionIdFromLocation();
    this.directory = directoryFromLocation();
    this.ui.mount();
    this.ui.update({ muted: this.muted, state: "idle", lang: this.lang });
    this.link.open();
    void this.refreshStatus();
    this.watchVoicePluginSelector();
    window.addEventListener("storage", (event) => {
      if (event.key === VOICE_PLUGIN_LANG_KEY || event.key === LANG_KEY) this.setLanguage(resolveLanguagePreference(), false);
    });

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
    const nextDirectory = directoryFromLocation();
    if (nextDirectory && nextDirectory !== this.directory) {
      this.directory = nextDirectory;
      this.link.attach(this.sessionID, this.directory, !document.hidden);
    }
    if (next === this.sessionID) return;
    // Arriving on a session we just created: keep listening, do not tear down.
    if (next && this.sessionID === "") {
      log.info("new session materialised", { sessionID: next });
      this.sessionID = next;
      this.link.attach(next, this.directory, !document.hidden);
      return;
    }
    if (!next) return;
    log.info("session changed", { from: this.sessionID, to: next });
    const wasLive = this.live;
    if (wasLive) void this.stopListening();
    this.link.send({ type: "detach", sessionID: this.sessionID });
    this.player.cancel();
    this.sessionID = next;
    this.link.attach(next, this.directory, !document.hidden);
    if (wasLive) void this.toggleLive(true);
  }

  private async refreshStatus() {
    try {
      const res = await fetch(DaemonLink.apiUrl("/api/status"));
      if (!res.ok) return;
      const status = (await res.json()) as { tts: { ready: boolean }; stt: { ready: boolean }; speech?: { languages: string[] } };
      this.serverVoice = status.tts.ready;
      this.serverEars = status.stt.ready;
      if (status.speech?.languages?.length) this.languages = status.speech.languages;
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

  // ---- language -----------------------------------------------------------

  /** What a single-language recognizer is asked to hear: never "auto". */
  private recognizerLang(): string {
    if (this.lang !== "auto") return this.lang;
    const nav = navigator.language || "";
    const match = this.languages.find((code) => nav.toLowerCase().startsWith(code));
    const code = match ?? this.languages[0] ?? "fr";
    return regionalize(code);
  }

  /** The language sent with a transcript; undefined lets the daemon decide. */
  private transcriptLang(): string | undefined {
    return this.lang === "auto" ? undefined : this.lang;
  }

  private cycleLanguage() {
    const options = [...this.languages.map(regionalize), "auto"];
    const index = options.indexOf(this.lang);
    this.setLanguage(options[(index + 1) % options.length], true);
  }

  private setLanguage(next: string, persist: boolean) {
    if (next === this.lang) return;
    this.lang = next;
    if (persist) {
      writeString(LANG_KEY, next);
      writeString(VOICE_PLUGIN_LANG_KEY, next);
      // Keep the shared selector in step so the voice plugin follows too.
      const select = document.querySelector<HTMLSelectElement>(VOICE_PLUGIN_SELECT);
      if (select && select.value !== next && [...select.options].some((o) => o.value === next)) {
        select.value = next;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    this.player.setLang(this.recognizerLang());
    if (this.recognizer) {
      this.recognizer.setLang(this.recognizerLang());
      // A running recognizer keeps its language; restart it with the new one.
      this.recognizer.stop();
      this.recognizer.start();
    }
    this.link.send({ type: "prefs", sessionID: this.sessionID, lang: this.transcriptLang() });
    this.ui.update({ lang: next });
    log.info("language", { lang: next, recognizer: this.recognizerLang() });
  }

  /** Follow the opencode-web-voice selector when that plugin is present. */
  private watchVoicePluginSelector() {
    const hook = () => {
      const select = document.querySelector<HTMLSelectElement>(VOICE_PLUGIN_SELECT);
      if (!select || select === this.voicePluginSelect) return;
      this.voicePluginSelect = select;
      select.addEventListener("change", () => {
        const value = select.value || "auto";
        writeString(LANG_KEY, value);
        this.setLanguage(value, false);
      });
      // The selector may appear after we resolved the preference: adopt its value.
      if (select.value && select.value !== this.lang) this.setLanguage(select.value, false);
    };
    hook();
    new MutationObserver(hook).observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---- live mode ----------------------------------------------------------

  private async toggleLive(force?: boolean) {
    const next = force ?? !this.live;
    if (next === this.live) return;
    this.live = next;
    writeFlag(LIVE_KEY, next);
    this.ui.update({ live: next, state: next ? "listening" : "idle" });
    this.link.send({ type: "live", sessionID: this.sessionID, enabled: next, directory: this.directory });
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
      this.recognizer.setLang(this.recognizerLang());
      await this.recognizer.prepareOnDevice();
      this.recognizer.start();
      log.info("using browser recognition", { lang: this.recognizerLang(), biasing: this.recognizer.supportsBiasing, onDevice: this.recognizer.supportsOnDevice });
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
        { sessionID: this.sessionID, directory: this.directory, lang: this.transcriptLang(), bargeIn, spokenOver: context.spokenOver, apply: true },
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
    this.recognizer.setLang(this.recognizerLang());
    await this.recognizer.prepareOnDevice();
    this.recognizer.start();
    log.info("switched to browser recognition", { lang: this.recognizerLang() });
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
      // The browser recognizer always ran in one concrete language.
      lang: this.recognizerLang(),
      directory: this.directory,
    });
  }

  // ---- daemon messages ----------------------------------------------------

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "hello":
      case "status": {
        this.serverVoice = msg.status.tts.ready;
        this.serverEars = msg.status.stt.ready;
        if (msg.status.speech?.languages?.length) this.languages = msg.status.speech.languages;
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
      case "navigate": {
        this.followNavigation(msg.sessionID, msg.directory, msg.url);
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

  /**
   * The daemon created a session for us. Move the page onto it without a
   * reload, so the microphone and the audio graph survive; if the app's router
   * does not follow, load the address outright rather than leave the user
   * looking at a page that no longer matches the conversation.
   */
  private followNavigation(sessionID: string, directory: string, url: string) {
    log.info("following the new session", { sessionID, url });
    this.sessionID = sessionID;
    if (directory) this.directory = directory;
    if (sessionIdFromLocation() === sessionID) return;
    try {
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    } catch (err) {
      log.warn("pushState refused, loading the address", err);
      location.assign(url);
      return;
    }
    // A router that ignored the event leaves the old view in place; the URL is
    // the only thing we can check, so check it and fall back to a real load.
    window.setTimeout(() => {
      if (this.destroyed) return;
      if (sessionIdFromLocation() !== sessionID) {
        log.warn("the app did not follow, loading the address");
        location.assign(url);
      }
    }, 900);
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

/**
 * The workspace the page is looking at. OpenCode Web puts it in the path as
 * base64, and it is there even on the new-session page (`/:dir/session`),
 * which is exactly what the daemon needs to create a session on the user's
 * first spoken word.
 */
export function directoryFromLocation(pathname = location.pathname): string {
  const match = pathname.match(/^\/([^/]+)\/session(?:\/|$)/);
  if (!match) return "";
  return decodeBase64(match[1]);
}

function decodeBase64(value: string): string {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    // A real path, not a route segment that merely looked like base64.
    return decoded.startsWith("/") || decoded.includes("/") ? decoded : "";
  } catch {
    return "";
  }
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

function writeString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not persisted, still applied for this page
  }
}

/**
 * One language switch for both plugins: the opencode-web-voice selector and
 * its storage key are the source of truth when that plugin is installed. The
 * cockpit's own key only matters without it. Values are BCP-47 tags or "auto".
 */
export function resolveLanguagePreference(): string {
  const select = typeof document !== "undefined" ? document.querySelector<HTMLSelectElement>(VOICE_PLUGIN_SELECT) : null;
  if (select?.value) return select.value;
  const shared = readString(VOICE_PLUGIN_LANG_KEY, "");
  if (shared) return shared;
  const own = readString(LANG_KEY, "");
  if (own) return own;
  return "auto";
}

/** "fr" -> "fr-FR" through ICU likely subtags; a full tag passes through. */
export function regionalize(code: string): string {
  if (code.includes("-")) return code;
  try {
    const locale = new Intl.Locale(code).maximize();
    return locale.region ? `${locale.language}-${locale.region}` : code;
  } catch {
    return code;
  }
}

const scope = globalThis as Global;
scope[STATE_KEY]?.destroy();
const app = new CockpitApp();
scope[STATE_KEY] = { destroy: () => app.destroy(), logs: () => log.records(), version: typeof __VERSION__ === "string" ? __VERSION__ : "dev" };
void app.start();
