import { SPEECH_PRIORITY, type Utterance } from "../../shared/protocol.js";
import { log } from "../log.js";
import { postTts } from "../net.js";

/**
 * The voice.
 *
 * A priority queue of utterances played through one audio graph. Server
 * synthesis (Kokoro and friends, through the daemon) is preferred; the
 * browser's own `speechSynthesis` is the fallback, chunked because Chromium
 * truncates long utterances.
 *
 * Two behaviours matter for the feel of the thing:
 *
 * - **Preemption.** A blocking event outranks a narration beat, so it plays
 *   at once and the beat is dropped. Items of the same answer keep their
 *   order through a stream id and sequence number.
 * - **Resumable interruption.** A barge-in stops audio instantly and keeps
 *   what was already heard, so the session can either resume mid-answer or
 *   tell the streamer exactly where the user cut in.
 */

export type PlayerEvents = {
  onStart: (utterance: Utterance) => void;
  onEnd: (utterance: Utterance, completed: boolean, heardText: string) => void;
  onIdle: () => void;
  onError: (error: unknown) => void;
};

type QueueItem = {
  utterance: Utterance;
  enqueuedAt: number;
  /** Prefetched audio, when synthesis ran ahead of playback. */
  audio?: Promise<Blob | undefined>;
};

export type PlayerOptions = {
  /** Called to know whether server TTS is available right now. */
  serverAvailable: () => boolean;
  rate?: number;
  lang?: string;
};

export class VoicePlayer {
  private queue: QueueItem[] = [];
  private current?: { item: QueueItem; startedAt: number; stop: (completed: boolean) => void };
  private context?: AudioContext;
  private destination?: MediaStreamAudioDestinationNode;
  private gain?: GainNode;
  private playing = false;
  private paused = false;
  private rate: number;
  private lang: string;
  /** Utterance streams that were cancelled; late chunks of them are dropped. */
  private readonly deadStreams = new Set<string>();
  private lastCompleted?: { utterance: Utterance; text: string };

  constructor(
    private readonly opts: PlayerOptions,
    private readonly events: PlayerEvents,
  ) {
    this.rate = opts.rate ?? 1;
    this.lang = opts.lang ?? "fr-FR";
  }

  /**
   * The audio graph. Output is routed through a MediaStream so the microphone
   * capture can reference it for echo cancellation, which browsers only apply
   * to audio they consider remote.
   */
  async unlock(): Promise<MediaStream | undefined> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return undefined;
      this.context = new Ctor();
      this.gain = this.context.createGain();
      this.destination = this.context.createMediaStreamDestination();
      this.gain.connect(this.context.destination);
      this.gain.connect(this.destination);
    }
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);
    // A near-silent utterance satisfies the browser's gesture requirement.
    if ("speechSynthesis" in window) {
      try {
        const warmup = new SpeechSynthesisUtterance(" ");
        warmup.volume = 0;
        speechSynthesis.speak(warmup);
      } catch {
        // not fatal
      }
    }
    return this.destination?.stream;
  }

  setRate(rate: number) {
    this.rate = Math.max(0.6, Math.min(2, rate));
  }

  setLang(lang: string) {
    this.lang = lang;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get pending(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  enqueue(utterance: Utterance) {
    if (utterance.streamId && this.deadStreams.has(utterance.streamId)) return;
    const item: QueueItem = { utterance, enqueuedAt: Date.now() };
    this.queue.push(item);
    this.sortQueue();
    this.prefetch();
    // A strictly more urgent item interrupts what is playing.
    if (this.current && SPEECH_PRIORITY[utterance.kind] > SPEECH_PRIORITY[this.current.item.utterance.kind]) {
      log.debug("preempting", this.current.item.utterance.kind, "for", utterance.kind);
      this.current.stop(false);
    }
    void this.pump();
  }

  /**
   * Order by priority, then by position inside an answer stream, then by
   * arrival. Answer chunks must never overtake each other.
   */
  private sortQueue() {
    this.queue.sort((a, b) => {
      const byPriority = SPEECH_PRIORITY[b.utterance.kind] - SPEECH_PRIORITY[a.utterance.kind];
      if (byPriority !== 0) return byPriority;
      if (a.utterance.streamId && a.utterance.streamId === b.utterance.streamId) {
        return (a.utterance.streamSeq ?? 0) - (b.utterance.streamSeq ?? 0);
      }
      return a.enqueuedAt - b.enqueuedAt;
    });
  }

  /** Synthesize the next couple of items while the current one plays. */
  private prefetch() {
    if (!this.opts.serverAvailable()) return;
    for (const item of this.queue.slice(0, 2)) {
      if (item.audio) continue;
      item.audio = postTts(item.utterance.text)
        .catch((err) => {
          log.warn("tts prefetch failed", err);
          return undefined;
        });
    }
  }

  private async pump() {
    if (this.playing || this.paused) return;
    const item = this.nextPlayable();
    if (!item) {
      this.events.onIdle();
      return;
    }
    this.playing = true;
    this.events.onStart(item.utterance);
    try {
      await this.play(item);
    } catch (err) {
      log.warn("playback failed", err);
      this.events.onError(err);
    } finally {
      this.playing = false;
      this.prefetch();
      void this.pump();
    }
  }

  /** Drop expired items; return the first one still worth saying. */
  private nextPlayable(): QueueItem | undefined {
    const now = Date.now();
    while (this.queue.length) {
      const item = this.queue[0];
      const { expiresAt, streamId, kind } = item.utterance;
      const expired = expiresAt > 0 && now > expiresAt;
      const dead = streamId ? this.deadStreams.has(streamId) : false;
      if (!expired && !dead) return this.queue.shift();
      this.queue.shift();
      log.debug("dropping utterance", { kind, reason: expired ? "expired" : "cancelled" });
    }
    return undefined;
  }

  private async play(item: QueueItem): Promise<void> {
    const blob = this.opts.serverAvailable() ? await (item.audio ?? postTts(item.utterance.text).catch(() => undefined)) : undefined;
    if (blob && this.context) {
      await this.playBuffer(item, blob);
      return;
    }
    await this.playSpeechSynthesis(item);
  }

  private async playBuffer(item: QueueItem, blob: Blob): Promise<void> {
    const context = this.context!;
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(await blob.arrayBuffer());
    } catch (err) {
      log.warn("decode failed, falling back to browser voice", err);
      await this.playSpeechSynthesis(item);
      return;
    }
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = this.rate;
      source.connect(this.gain!);
      const startedAt = context.currentTime;
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        const elapsed = Math.max(0, context.currentTime - startedAt);
        const fraction = buffer.duration > 0 ? Math.min(1, elapsed / buffer.duration) : 1;
        this.current = undefined;
        this.finishItem(item, completed, fraction);
        resolve();
      };
      source.onended = () => finish(true);
      this.current = {
        item,
        startedAt: Date.now(),
        stop: (completed) => {
          try {
            source.stop();
          } catch {
            // already stopped
          }
          finish(completed);
        },
      };
      try {
        source.start();
      } catch (err) {
        log.warn("audio start failed", err);
        finish(false);
      }
    });
  }

  /**
   * Browser fallback. Chromium cuts utterances at roughly fifteen seconds, so
   * the text is chunked and chained; a watchdog covers the case where `onend`
   * never fires, which happens when an utterance is garbage collected.
   */
  private async playSpeechSynthesis(item: QueueItem): Promise<void> {
    if (!("speechSynthesis" in window)) {
      this.finishItem(item, true, 1);
      return;
    }
    const chunks = chunkForSynthesis(item.utterance.text);
    let spokenChunks = 0;
    let cancelled = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        this.current = undefined;
        const fraction = chunks.length ? spokenChunks / chunks.length : 1;
        this.finishItem(item, completed, fraction);
        resolve();
      };
      this.current = {
        item,
        startedAt: Date.now(),
        stop: (completed) => {
          cancelled = true;
          try {
            speechSynthesis.cancel();
          } catch {
            // ignore
          }
          finish(completed);
        },
      };
      const speakNext = (index: number) => {
        if (cancelled) return;
        if (index >= chunks.length) {
          finish(true);
          return;
        }
        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        utterance.lang = this.lang;
        utterance.rate = this.rate;
        const voice = pickVoice(this.lang);
        if (voice) utterance.voice = voice;
        let advanced = false;
        const advance = () => {
          if (advanced) return;
          advanced = true;
          window.clearTimeout(watchdog);
          spokenChunks = index + 1;
          speakNext(index + 1);
        };
        utterance.onend = advance;
        utterance.onerror = advance;
        // Roughly 12 characters per second, plus headroom.
        const watchdog = window.setTimeout(advance, 4000 + chunks[index].length * 90);
        try {
          speechSynthesis.speak(utterance);
        } catch (err) {
          log.warn("speechSynthesis.speak failed", err);
          advance();
        }
      };
      speakNext(0);
    });
  }

  private finishItem(item: QueueItem, completed: boolean, fraction: number) {
    const heardText = completed ? item.utterance.text : approximateHeard(item.utterance.text, fraction);
    if (completed) this.lastCompleted = { utterance: item.utterance, text: item.utterance.text };
    this.events.onEnd(item.utterance, completed, heardText);
  }

  /**
   * Stop immediately, keeping the queue. Returns what the user actually heard,
   * which the daemon passes to the streamer so it knows where it was cut.
   */
  interrupt(): string {
    const playing = this.current;
    if (!playing) return this.lastCompleted?.text ?? "";
    const utterance = playing.item.utterance;
    playing.stop(false);
    this.paused = true;
    return utterance.text;
  }

  /** Continue after a barge-in that led nowhere. */
  resume() {
    this.paused = false;
    void this.pump();
  }

  /** Drop pending speech. With no argument, everything. */
  cancel(opts: { utteranceId?: string; streamId?: string } = {}) {
    if (opts.streamId) {
      this.deadStreams.add(opts.streamId);
      if (this.deadStreams.size > 50) this.deadStreams.delete(this.deadStreams.values().next().value as string);
      this.queue = this.queue.filter((item) => item.utterance.streamId !== opts.streamId);
      if (this.current?.item.utterance.streamId === opts.streamId) this.current.stop(false);
    } else if (opts.utteranceId) {
      this.queue = this.queue.filter((item) => item.utterance.id !== opts.utteranceId);
      if (this.current?.item.utterance.id === opts.utteranceId) this.current.stop(false);
    } else {
      this.queue = [];
      this.current?.stop(false);
    }
    this.paused = false;
  }

  /** Say the last completed utterance again. */
  repeat(): boolean {
    const last = this.lastCompleted;
    if (!last) return false;
    this.enqueue({ ...last.utterance, id: `${last.utterance.id}_repeat`, streamId: undefined, streamSeq: undefined, expiresAt: 0 });
    return true;
  }

  destroy() {
    this.cancel();
    try {
      speechSynthesis.cancel();
    } catch {
      // ignore
    }
    void this.context?.close().catch(() => undefined);
    this.context = undefined;
  }
}

/** Chromium truncates long utterances; keep each piece comfortably short. */
export function chunkForSynthesis(text: string, limit = 180): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" : "), window.lastIndexOf(" "));
    const at = cut > 40 ? cut + 1 : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** What the listener heard before the cut, to the nearest word. */
export function approximateHeard(text: string, fraction: number): string {
  if (fraction >= 1) return text;
  if (fraction <= 0) return "";
  const cut = Math.floor(text.length * fraction);
  const space = text.lastIndexOf(" ", cut);
  return text.slice(0, space > 0 ? space : cut).trim();
}

let voiceCache: SpeechSynthesisVoice[] = [];

export function primeVoices() {
  if (!("speechSynthesis" in window)) return;
  const update = () => {
    const list = speechSynthesis.getVoices();
    if (list.length) voiceCache = list;
  };
  update();
  speechSynthesis.addEventListener?.("voiceschanged", update);
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (!voiceCache.length && "speechSynthesis" in window) voiceCache = speechSynthesis.getVoices();
  const prefix = lang.slice(0, 2).toLowerCase();
  return (
    voiceCache.find((v) => v.lang === lang && v.localService) ??
    voiceCache.find((v) => v.lang === lang) ??
    voiceCache.find((v) => v.lang.toLowerCase().startsWith(prefix))
  );
}
