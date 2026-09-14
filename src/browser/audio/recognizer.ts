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
  private consecutiveErrors = 0;
  private lang = "fr-FR";
  private phrases: string[] = [];
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
    if (this.recognition) this.recognition.lang = lang;
  }

  /**
   * Install the project vocabulary. Biasing is applied where supported; the
   * call is harmless where it is not.
   */
  setPhrases(phrases: string[]) {
    this.phrases = phrases;
    if (this.recognition) this.applyPhrases(this.recognition);
  }

  /** Ask the browser to fetch the on-device model, where that exists. */
  async prepareOnDevice(): Promise<boolean> {
    const Ctor = recognitionCtor();
    if (!Ctor?.available) return false;
    try {
      const state = await Ctor.available({ langs: [this.lang], processLocally: true });
      if (state === "available") return true;
      if (state === "downloadable" && Ctor.install) {
        log.info("downloading on-device speech model", this.lang);
        return await Ctor.install({ langs: [this.lang] });
      }
      return false;
    } catch (err) {
      log.debug("on-device probe failed", err);
      return false;
    }
  }

  start() {
    this.wantRunning = true;
    this.spawn();
  }

  private spawn() {
    if (!this.wantRunning || this.recognition) return;
    const Ctor = recognitionCtor();
    if (!Ctor) {
      this.events.onError("unsupported");
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;
    recognition.maxAlternatives = 1;
    this.applyPhrases(recognition);
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) {
          const text = alternative.transcript.trim();
          if (text) this.events.onFinal(text, alternative.confidence ?? 0);
        } else {
          interim += alternative.transcript;
        }
      }
      if (interim.trim()) this.events.onInterim(interim.trim());
    };
    recognition.onerror = (event) => {
      const error = event.error || "unknown";
      // Silence and manual stops are normal operation, not failures.
      if (error === "no-speech" || error === "aborted") return;
      this.consecutiveErrors += 1;
      log.warn("recognition error", error, event.message ?? "");
      this.events.onError(error);
      if (error === "not-allowed" || error === "service-not-allowed") this.wantRunning = false;
    };
    recognition.onend = () => {
      this.recognition = undefined;
      if (!this.wantRunning) return;
      // Back off only after repeated failures; a clean end restarts at once.
      const delay = this.consecutiveErrors > 1 ? Math.min(500 * 2 ** this.consecutiveErrors, 20000) : 150;
      this.restartTimer = window.setTimeout(() => {
        this.restartTimer = undefined;
        this.spawn();
      }, delay);
    };
    recognition.onstart = () => {
      this.consecutiveErrors = 0;
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
    if (!this.supportsBiasing || !this.phrases.length) return;
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

  stop() {
    this.wantRunning = false;
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
