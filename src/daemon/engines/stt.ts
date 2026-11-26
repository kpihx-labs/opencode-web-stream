import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";
import { originOf } from "./tts.js";

const execFile = promisify(execFileCb);

export type SttMode = "auto" | "hex" | "browser" | "url";

/**
 * Transcription supporting:
 *   1. Local Hex CLI (`hex transcribe <file> --model orukeet --json`, default),
 *   2. OpenAI-compatible `/v1/audio/transcriptions` endpoint (`cfg.stt.url`),
 *   3. Browser online Web Speech API (`mode: "browser"` -> `ready: false`).
 */

export class SttEngine {
  private ready = false;
  private lastCheck = 0;
  private checking?: Promise<boolean>;
  private hexAvailable: boolean | undefined;

  constructor(
    private readonly cfg: Config["stt"],
    private readonly log: ScopedLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get mode(): SttMode {
    return this.cfg.mode ?? "hex";
  }

  setMode(next: SttMode) {
    if (this.cfg.mode === next) return;
    this.cfg.mode = next;
    this.lastCheck = 0;
    this.log.info("stt mode changed", { mode: next });
  }

  private effectiveEngine(): "hex" | "server" | "browser" {
    const m = this.mode;
    if (m === "browser") return "browser";
    if (m === "url") return this.cfg.url ? "server" : "browser";
    if (m === "hex") return "hex";
    // auto
    if (this.cfg.url) return "server";
    return "hex";
  }

  get enabled(): boolean {
    const eff = this.effectiveEngine();
    return eff === "hex" || (eff === "server" && Boolean(this.cfg.url));
  }

  get isReady(): boolean {
    return this.enabled && this.ready;
  }

  describe() {
    const eff = this.effectiveEngine();
    return {
      engine: this.isReady ? eff : ("browser" as const),
      ready: this.isReady,
      mode: this.mode,
      model: this.cfg.model,
    };
  }

  async check(force = false): Promise<boolean> {
    const eff = this.effectiveEngine();
    if (eff === "browser") {
      this.ready = false;
      this.lastCheck = Date.now();
      return false;
    }
    const now = Date.now();
    if (!force && now - this.lastCheck < 30000) return this.ready;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let ok = false;
      if (eff === "hex") {
        if (this.hexAvailable === undefined || force) {
          try {
            const { stdout } = await execFile(this.cfg.binary || "hex", ["--version"], { timeout: 2500 });
            ok = Boolean(stdout.trim());
          } catch {
            ok = false;
          }
          this.hexAvailable = ok;
        } else {
          ok = this.hexAvailable;
        }
      } else if (this.cfg.url) {
        const base = originOf(this.cfg.url);
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
      }
      this.lastCheck = Date.now();
      if (ok !== this.ready) {
        this.log.info(ok ? "stt engine ready" : "stt engine unavailable (browser fallback)", {
          engine: eff,
          model: this.cfg.model,
          url: this.cfg.url || undefined,
        });
      }
      this.ready = ok;
      this.checking = undefined;
      return ok;
    })();
    return this.checking;
  }

  /**
   * @param audio WebM/WAV/MP3/Ogg bytes.
   * @param promptTerms vocabulary to bias toward when using an HTTP Whisper endpoint.
   * @returns the transcript and, when reported, the detected language.
   */
  async transcribe(
    audio: Buffer,
    opts: { mime?: string; language?: string; promptTerms?: string[]; signal?: AbortSignal } = {},
  ): Promise<{ text: string; language?: string }> {
    const eff = this.effectiveEngine();
    if (eff === "browser") throw new Error("server stt disabled (browser mode)");
    if (eff === "hex") {
      return this.transcribeHex(audio, opts);
    }
    if (!this.cfg.url) throw new Error("server stt disabled");
    const form = new FormData();
    const mime = opts.mime ?? "audio/wav";
    const ext = mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "wav";
    form.set("file", new Blob([new Uint8Array(audio)], { type: mime }), `utterance.${ext}`);
    form.set("model", this.cfg.model);
    // verbose_json carries the language Whisper detected when none is forced.
    form.set("response_format", "verbose_json");
    const language = opts.language ?? this.cfg.language;
    if (language && language !== "auto") form.set("language", language.toLowerCase().split(/[-_]/)[0]);
    const terms = (opts.promptTerms ?? []).slice(0, this.cfg.promptTerms);
    if (terms.length) form.set("prompt", buildPrompt(terms));
    const controller = new AbortController();
    const timer = this.cfg.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("stt timeout")), this.cfg.timeoutMs) : undefined;
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchImpl(this.cfg.url, { method: "POST", body: form, signal: controller.signal });
      if (!res.ok) {
        this.ready = false;
        throw new Error(`stt HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string; language?: string };
      this.ready = true;
      return { text: (data.text ?? "").trim(), language: normalizeLanguage(data.language) };
    } catch (e) {
      if (!(e instanceof Error && /HTTP/.test(e.message))) this.ready = false;
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async transcribeHex(
    audio: Buffer,
    opts: { mime?: string; language?: string; signal?: AbortSignal },
  ): Promise<{ text: string; language?: string }> {
    const t0 = Date.now();
    const mime = opts.mime ?? "audio/webm";
    const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "webm";
    const dir = "/tmp/opencode";
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, `ows-stt-${randomUUID()}.${ext}`);
    await writeFile(tmpPath, audio);
    const langRaw = opts.language ?? this.cfg.language;
    const lang = langRaw && langRaw !== "auto" ? langRaw.toLowerCase().split(/[-_]/)[0] : "";
    try {
      const model = this.cfg.model || "orukeet";
      const args = ["transcribe", tmpPath, "--model", model, "--json"];
      if (lang && model !== "orukeet") args.push("--language", lang);
      const { stdout } = await execFile(this.cfg.binary || "hex", args, {
        ...(this.cfg.timeoutMs > 0 ? { timeout: this.cfg.timeoutMs } : {}),
        signal: opts.signal,
      });
      const parsed = JSON.parse(stdout) as { text?: string };
      const text = (parsed.text ?? "").trim();
      this.ready = true;
      this.log.debug("hex stt ok", {
        model,
        bytes: audio.length,
        elapsedMs: Date.now() - t0,
        text: text.slice(0, 120),
      });
      return { text, language: lang || undefined };
    } catch (e) {
      const errObj = e as { message?: string; stdout?: string; stderr?: string };
      // Ambient silence / non-speech clips return exit 1 with code:"no-speech": treat as empty transcript, NOT engine crash!
      if (typeof errObj?.stdout === "string" && errObj.stdout.trim().startsWith("{")) {
        try {
          const parsedErr = JSON.parse(errObj.stdout) as { code?: string };
          if (parsedErr.code === "no-speech") {
            this.ready = true;
            this.log.debug("hex stt no speech", { bytes: audio.length, elapsedMs: Date.now() - t0 });
            return { text: "", language: lang || undefined };
          }
        } catch {
          // fall through to warn/throw
        }
      }
      this.log.warn("hex stt failed", {
        elapsedMs: Date.now() - t0,
        bytes: audio.length,
        ext,
        error: errObj?.message ?? String(e),
        stdout: errObj?.stdout?.slice(0, 200),
        stderr: errObj?.stderr?.slice(0, 200),
      });
      throw e;
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }
  }
}

/** Whisper servers report "french", "fr" or "fr-FR" depending on the build. */
export function normalizeLanguage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (value.length <= 3) return value.split(/[-_]/)[0];
  // Full names: ask ICU which code displays as this name.
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  for (const code of ["fr", "en", "de", "es", "it", "pt", "nl", "ja", "zh", "ko", "ru", "ar"]) {
    if (names.of(code)?.toLowerCase() === value) return code;
  }
  return value.split(/[-_]/)[0].slice(0, 3);
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
