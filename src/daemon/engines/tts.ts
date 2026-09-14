import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";

/**
 * Speech synthesis through an OpenAI-compatible `/v1/audio/speech` endpoint
 * (speaches, Kokoro-FastAPI, openedai-speech, ...). The daemon only proxies:
 * the browser asks for one sentence at a time and plays the bytes.
 */

export type TtsResult = { bytes: Buffer; contentType: string };

export class TtsEngine {
  private ready = false;
  private lastCheck = 0;
  private checking?: Promise<boolean>;

  constructor(
    private readonly cfg: Config["tts"],
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
    return { engine: this.isReady ? ("server" as const) : ("browser" as const), ready: this.isReady, voice: this.cfg.voice };
  }

  /** Probe the endpoint's server; cached for 30 s. */
  async check(force = false): Promise<boolean> {
    if (!this.enabled) return false;
    const now = Date.now();
    if (!force && now - this.lastCheck < 30000) return this.ready;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const base = originOf(this.cfg.url);
      const probes = [`${base}/health`, `${base}/v1/models`, base + "/"];
      let ok = false;
      for (const url of probes) {
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(2500) });
          if (res.ok || res.status === 404 || res.status === 405) {
            ok = true;
            break;
          }
        } catch {
          // try next probe
        }
      }
      this.lastCheck = Date.now();
      if (ok !== this.ready) this.log.info(ok ? "tts endpoint reachable" : "tts endpoint unreachable", { url: this.cfg.url });
      this.ready = ok;
      this.checking = undefined;
      return ok;
    })();
    return this.checking;
  }

  async synthesize(text: string, opts: { voice?: string; speed?: number; signal?: AbortSignal } = {}): Promise<TtsResult> {
    if (!this.enabled) throw new Error("server tts disabled");
    const body = {
      model: this.cfg.model,
      input: text,
      voice: opts.voice ?? this.cfg.voice,
      response_format: this.cfg.format,
      speed: opts.speed ?? this.cfg.speed,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("tts timeout")), this.cfg.timeoutMs);
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.ready = false;
        throw new Error(`tts HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      this.ready = true;
      return { bytes, contentType: res.headers.get("content-type") ?? mimeFor(this.cfg.format) };
    } catch (e) {
      if (!(e instanceof Error && /HTTP/.test(e.message))) this.ready = false;
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

export function mimeFor(format: string): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "opus":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/pcm";
    default:
      return "audio/wav";
  }
}
