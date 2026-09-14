import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";
import { originOf } from "./tts.js";

/**
 * Transcription through an OpenAI-compatible `/v1/audio/transcriptions`
 * endpoint (speaches, faster-whisper-server, whisper.cpp server, ...). The
 * project vocabulary is passed as the Whisper `prompt`, which biases the
 * decoder toward those spellings.
 */

export class SttEngine {
  private ready = false;
  private lastCheck = 0;
  private checking?: Promise<boolean>;

  constructor(
    private readonly cfg: Config["stt"],
    private readonly log: ScopedLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.cfg.url);
  }

  get isReady(): boolean {
    return this.enabled && this.ready;
  }

  describe() {
    return { engine: this.isReady ? ("server" as const) : ("browser" as const), ready: this.isReady };
  }

  async check(force = false): Promise<boolean> {
    if (!this.enabled) return false;
    const now = Date.now();
    if (!force && now - this.lastCheck < 30000) return this.ready;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const base = originOf(this.cfg.url);
      let ok = false;
      for (const url of [`${base}/health`, `${base}/v1/models`, base + "/"]) {
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(2500) });
          if (res.ok || res.status === 404 || res.status === 405) {
            ok = true;
            break;
          }
        } catch {
          // next probe
        }
      }
      this.lastCheck = Date.now();
      if (ok !== this.ready) this.log.info(ok ? "stt endpoint reachable" : "stt endpoint unreachable", { url: this.cfg.url });
      this.ready = ok;
      this.checking = undefined;
      return ok;
    })();
    return this.checking;
  }

  /**
   * @param audio WAV (or any container the server accepts) bytes.
   * @param promptTerms vocabulary to bias toward; joined into the Whisper prompt.
   */
  async transcribe(
    audio: Buffer,
    opts: { mime?: string; language?: string; promptTerms?: string[]; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (!this.enabled) throw new Error("server stt disabled");
    const form = new FormData();
    const mime = opts.mime ?? "audio/wav";
    const ext = mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "wav";
    form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `utterance.${ext}`);
    form.set("model", this.cfg.model);
    form.set("response_format", "json");
    const language = opts.language ?? this.cfg.language;
    if (language && language !== "auto") form.set("language", language.slice(0, 2));
    const terms = (opts.promptTerms ?? []).slice(0, this.cfg.promptTerms);
    if (terms.length) form.set("prompt", buildPrompt(terms));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("stt timeout")), this.cfg.timeoutMs);
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.cfg.url, { method: "POST", body: form, signal: controller.signal });
      if (!res.ok) {
        this.ready = false;
        throw new Error(`stt HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string };
      this.ready = true;
      return (data.text ?? "").trim();
    } catch (e) {
      if (!(e instanceof Error && /HTTP/.test(e.message))) this.ready = false;
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Whisper reads the prompt as preceding transcript; a comma-separated list of
 * terms, most important last, is what works best in practice. Kept well under
 * the 224-token window.
 */
export function buildPrompt(terms: string[]): string {
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  let out = "";
  for (const t of unique.reverse()) {
    const next = out ? `${t}, ${out}` : t;
    if (next.length > 600) break;
    out = next;
  }
  return out;
}
