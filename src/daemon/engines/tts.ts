import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";
import { prewarmEdgeTts, synthesizeEdgeTts, type WordBoundary } from "./edge-tts.js";

/**
 * Speech synthesis supporting:
 *   1. Explicit OpenAI-compatible `/v1/audio/speech` endpoint (when `cfg.tts.url` is set),
 *   2. Built-in Microsoft Edge Read Aloud WebSocket streaming (`edge-tts` protocol)
 *      with exact `WordBoundary` timings for accurate barge-in recovery,
 *   3. Automatic fallback to browser `speechSynthesis` if offline.
 */

export type TtsResult = { bytes: Buffer; contentType: string; boundaries?: WordBoundary[] };

export class TtsEngine {
  private ready = false;
  private lastCheck = 0;
  private checking?: Promise<boolean>;

  constructor(
    private readonly cfg: Config["tts"],
    private readonly log: ScopedLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get hasCustomEndpoint(): boolean {
    return Boolean(this.cfg.url);
  }

  get usesBuiltInEdge(): boolean {
    return !this.hasCustomEndpoint && this.cfg.mode !== "off";
  }

  get enabled(): boolean {
    return this.hasCustomEndpoint || this.usesBuiltInEdge;
  }

  get isReady(): boolean {
    return this.enabled && this.ready;
  }

  describe() {
    return {
      engine: this.isReady ? ("server" as const) : ("browser" as const),
      ready: this.isReady,
      voice: this.cfg.voice,
    };
  }

  /** The configured voice for a language, else the fallback voice. */
  voiceFor(lang?: string): string {
    const key = (lang ?? "").toLowerCase().split(/[-_]/)[0];
    return (key && this.cfg.voices[key]) || this.cfg.voice;
  }

  /** Probe the endpoint's server; cached for 30 s. */
  async check(force = false): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.usesBuiltInEdge) {
      this.ready = true;
      prewarmEdgeTts();
      return true;
    }
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

  async synthesize(
    text: string,
    opts: { voice?: string; lang?: string; speed?: number; signal?: AbortSignal } = {},
  ): Promise<TtsResult> {
    if (!this.enabled) throw new Error("server tts disabled");
    const voice = opts.voice ?? this.voiceFor(opts.lang);
    const speed = opts.speed ?? this.cfg.speed;

    if (this.usesBuiltInEdge) {
      const t0 = Date.now();
      try {
        const out = await synthesizeEdgeTts(text, {
          voice,
          lang: opts.lang,
          speed,
          timeoutMs: this.cfg.timeoutMs,
          signal: opts.signal,
        });
        this.ready = true;
        this.log.debug("edge-tts ok", { voice, chars: text.length, bytes: out.bytes.length, elapsedMs: Date.now() - t0 });
        return out;
      } catch (e) {
        this.ready = false;
        this.log.warn("edge-tts failed", { voice, elapsedMs: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }

    const body = {
      model: this.cfg.model,
      input: text,
      voice,
      response_format: this.cfg.format,
      speed,
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
      return "audio/opus";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/pcm";
    default:
      return "audio/wav";
  }
}
