import { log } from "../log.js";

/**
 * Browser speech recognition, used when the daemon has no transcription
 * endpoint.
 *
 * Two capabilities decide how good this is, and both are feature-detected:
 * on-device recognition, and contextual biasing through `phrases`, which is
 * what lets project names be recognized correctly. Where biasing is
 * unavailable the transcript still arrives; the streamer corrects it from the
 * candidate list instead.
 *
 * Continuous mode is not continuous in practice: the browser ends the session
 * on silence and after a while regardless. Restarting is therefore expected,
 * and only ever done from `onend` with a backoff, never while one is running.
 */

type RecognitionAlternative = { transcript: string; confidence: number };
type RecognitionResult = { isFinal: boolean; 0: RecognitionAlternative; length: number };
type RecognitionEvent = Event & { resultIndex: number; results: { length: number; [i: number]: RecognitionResult } };
type RecognitionErrorEvent = Event & { error: string; message?: string };

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  phrases?: unknown;
  processLocally?: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
};

type SpeechRecognitionCtor = (new () => SpeechRecognitionLike) & {
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[] }) => Promise<boolean>;
};

type PhraseCtor = new (phrase: string, boost: number) => unknown;

export type RecognizerEvents = {
  onFinal: (text: string, confidence: number) => void;
  onInterim: (text: string) => void;
  onError: (error: string) => void;
};

export class BrowserRecognizer {
  private recognition?: SpeechRecognitionLike;
  private wantRunning = false;
  private restartTimer?: number;
  private watchdogTimer?: number;
  private interimCommitTimer?: number;
  private consecutiveErrors = 0;
  private generation = 0;
  private sessionStartedAt = 0;
  private pendingInterim = "";
  private lastInterimAt = 0;
  private lastCommittedText = "";
  private lastCommittedAt = 0;
  private lang = "fr-FR";
  private phrases: string[] = [];
  private onDeviceReady = false;
  private biasingAllowed = true;
  supportsBiasing = false;
  supportsOnDevice = false;

  constructor(private readonly events: RecognizerEvents) {
    const Ctor = recognitionCtor();
    this.supportsBiasing = Boolean(Ctor && "phrases" in Ctor.prototype);
    this.supportsOnDevice = Boolean(Ctor && typeof Ctor.available === "function");
  }

  static get supported(): boolean {
    return Boolean(recognitionCtor());
  }

  setLang(lang: string) {
    this.lang = lang;
    this.onDeviceReady = false;
    if (this.recognition) this.recognition.lang = lang;
  }

  /** Cleanly restart recognition with a new language without racing Chromium's mic teardown. */
  restartWithLang(lang: string) {
    this.lang = lang;
    this.onDeviceReady = false;
    const wasRunning = this.wantRunning;
    this.stop();
    if (!wasRunning) return;
    this.wantRunning = true;
    this.startWatchdog();
    const seq = this.generation;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = undefined;
      if (this.wantRunning && seq === this.generation) this.spawn();
    }, 140);
  }

  /**
   * Install the project vocabulary. Biasing is applied only when supported
   * by the current recognition mode so unsupported engines never stall.
   */
  setPhrases(phrases: string[]) {
    this.phrases = phrases;
    if (this.recognition && this.onDeviceReady && this.biasingAllowed) {
      this.applyPhrases(this.recognition);
    }
  }

  /** Probe on-device model availability in the background (never blocks startup). */
  async prepareOnDevice(): Promise<boolean> {
    const Ctor = recognitionCtor();
    if (!Ctor?.available) return false;
    try {
      const state = await Ctor.available({ langs: [this.lang], processLocally: true });
      if (state === "available") {
        this.onDeviceReady = true;
        return true;
      }
      this.onDeviceReady = false;
      return false;
    } catch (err) {
      this.onDeviceReady = false;
      log.debug("on-device probe failed", err);
      return false;
    }
  }

  start() {
    this.wantRunning = true;
    this.startWatchdog();
    this.spawn();
    void this.prepareOnDevice().then((ready) => {
      if (ready && this.recognition && this.biasingAllowed) {
        this.applyPhrases(this.recognition);
      }
    });
  }

  private startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = window.setInterval(() => {
      if (!this.wantRunning) return;
      if (!this.recognition && !this.restartTimer) {
        log.debug("recognizer watchdog reviving stopped engine");
        this.spawn();
      }
    }, 2000);
  }

  private spawn() {
    if (!this.wantRunning || this.recognition) return;
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.events.onError("unsupported");
      return;
    }
    const seq = ++this.generation;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;
    recognition.maxAlternatives = 1;
    if (this.onDeviceReady && this.biasingAllowed) {
      this.applyPhrases(recognition);
    }
    recognition.onresult = (event) => {
      if (seq !== this.generation) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) {
          const text = alternative.transcript.trim();
          this.pendingInterim = "";
          if (this.interimCommitTimer) {
            window.clearTimeout(this.interimCommitTimer);
            this.interimCommitTimer = undefined;
          }
          if (text && !this.isDuplicateCommit(text)) {
            this.markCommitted(text);
            this.events.onFinal(text, alternative.confidence ?? 0);
          }
        } else {
          interim += alternative.transcript;
        }
      }
      const cleanInterim = interim.trim();
      if (cleanInterim) {
        this.pendingInterim = cleanInterim;
        this.lastInterimAt = Date.now();
        this.events.onInterim(cleanInterim);
      }
    };
    recognition.onerror = (event) => {
      if (seq !== this.generation) return;
      const error = event.error || "unknown";
      // Silence and manual stops are normal operation, not failures.
      if (error === "no-speech" || error === "aborted") return;
      // Edge on Linux advertises `phrases` / `available` on prototype, then throws
      // `phrases-not-supported` / `language-not-supported` once set. Disable local
      // biasing for the session and fall back to normal cloud recognition immediately.
      if (error === "phrases-not-supported" || error === "language-not-supported") {
        log.info("disabling local phrase biasing after engine rejection", { error, lang: this.lang });
        this.biasingAllowed = false;
        this.onDeviceReady = false;
        this.consecutiveErrors = 0;
        const stale = this.recognition;
        this.recognition = undefined;
        if (stale) {
          stale.onresult = null;
          stale.onend = null;
          stale.onerror = null;
          try {
            stale.abort();
          } catch {
            // ignore
          }
        }
        if (this.wantRunning && !this.restartTimer) {
          this.restartTimer = window.setTimeout(() => {
            this.restartTimer = undefined;
            if (this.wantRunning && seq === this.generation) this.spawn();
          }, 50);
        }
        return;
      }
      // Preserve any spoken interim text before Edge drops the stream on network idle.
      this.flushPendingInterim("error");
      if (error === "network" && Date.now() - this.sessionStartedAt > 8000) {
        this.consecutiveErrors = 0;
      } else {
        this.consecutiveErrors += 1;
      }
      log.warn("recognition error", error, event.message ?? "");
      this.events.onError(error);
      if (error === "not-allowed" || error === "service-not-allowed") this.wantRunning = false;
    };
    recognition.onend = () => {
      if (seq !== this.generation) return;
      this.flushPendingInterim("end");
      this.recognition = undefined;
      if (!this.wantRunning) return;
      // Keep recovery snappy so mid-session resets never drop the user's next sentence.
      const delay = this.consecutiveErrors > 2 ? Math.min(400 * 2 ** (this.consecutiveErrors - 2), 5000) : 60;
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = undefined;
        this.spawn();
      }, delay);
    };
    recognition.onstart = () => {
      this.consecutiveErrors = 0;
      this.sessionStartedAt = Date.now();
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch (err) {
      log.warn("recognition start failed", err);
      this.recognition = undefined;
      this.consecutiveErrors += 1;
    }
  }

  private applyPhrases(recognition: SpeechRecognitionLike) {
    if (!this.supportsBiasing || !this.biasingAllowed || !this.onDeviceReady || !this.phrases.length) return;
    const Phrase = (window as unknown as { SpeechRecognitionPhrase?: PhraseCtor }).SpeechRecognitionPhrase;
    if (!Phrase) return;
    try {
      // Empty strings break recognition outright; boost is capped by the spec.
      const list = this.phrases
        .map((p) => p.trim())
        .filter((p) => p.length > 1)
        .slice(0, 200)
        .map((p) => new Phrase(p, 3));
      (recognition as { phrases?: unknown }).phrases = list;
      (recognition as { processLocally?: boolean }).processLocally = true;
    } catch (err) {
      log.debug("phrase biasing rejected", err);
    }
  }

  /**
   * Called when our AudioWorklet VAD confirms silence after speech: nudge Chromium
   * to flush `isFinal` immediately instead of waiting ~2 s, with a fast fallback.
   */
  commitInterim() {
    if (!this.wantRunning || !this.pendingInterim) return;
    if (Date.now() - this.lastInterimAt < 180) return;
    if (this.interimCommitTimer) return;
    try {
      this.recognition?.stop();
    } catch {
      // ignore
    }
    this.interimCommitTimer = window.setTimeout(() => {
      this.interimCommitTimer = undefined;
      this.flushPendingInterim("vad-silence");
    }, 220);
  }

  private flushPendingInterim(reason: string) {
    if (this.interimCommitTimer) {
      window.clearTimeout(this.interimCommitTimer);
      this.interimCommitTimer = undefined;
    }
    const text = this.pendingInterim.trim();
    this.pendingInterim = "";
    if (!text || this.isDuplicateCommit(text)) return;
    this.markCommitted(text);
    log.debug("flushed interim transcript", { reason, text: text.slice(0, 80) });
    this.events.onFinal(text, 0.75);
  }

  private markCommitted(text: string) {
    this.lastCommittedText = text.toLowerCase();
    this.lastCommittedAt = Date.now();
  }

  private isDuplicateCommit(text: string): boolean {
    return Date.now() - this.lastCommittedAt < 2500 && text.toLowerCase() === this.lastCommittedText;
  }

  stop() {
    this.generation += 1;
    this.wantRunning = false;
    this.pendingInterim = "";
    if (this.interimCommitTimer) window.clearTimeout(this.interimCommitTimer);
    this.interimCommitTimer = undefined;
    if (this.watchdogTimer) window.clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    if (this.restartTimer) window.clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const recognition = this.recognition;
    this.recognition = undefined;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch {
      // already gone
    }
  }
}

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
