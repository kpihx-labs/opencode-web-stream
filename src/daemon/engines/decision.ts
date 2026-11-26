import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";

/**
 * Fast local/free System-One decision gate replacing paid external routers.
 *
 * Calls an OpenAI-compatible small local model (default: OpenVINO `qwen3-0.6b`
 * on 127.0.0.1:11437 with `enable_thinking: false`) using strict JSON output
 * to make sub-300ms triage decisions (stop/noise barge-in or low-salience beat
 * skip). When unavailable, gracefully returns `pass` so the main `streamer`
 * agent handles everything without stalls.
 */

export type VoiceTriage = "stop" | "noise" | "pass";

export class DecisionEngine {
  private ready = false;
  private lastCheck = 0;
  private checking?: Promise<boolean>;

  constructor(
    private readonly cfg: Config["decision"],
    private readonly log: ScopedLogger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.url);
  }

  get isReady(): boolean {
    return this.enabled && this.ready;
  }

  describe() {
    return { enabled: this.enabled, ready: this.isReady, model: this.cfg.model, url: this.cfg.url };
  }

  async check(force = false): Promise<boolean> {
    if (!this.enabled) return false;
    const now = Date.now();
    if (!force && now - this.lastCheck < 30_000) return this.ready;
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const origin = originOf(this.cfg.url);
      let ok = false;
      for (const probe of [`${origin}/v1/models`, `${origin}/health`]) {
        try {
          const res = await this.fetchImpl(probe, { signal: AbortSignal.timeout(1500) });
          if (res.ok) {
            ok = true;
            break;
          }
        } catch {
          // next
        }
      }
      this.lastCheck = Date.now();
      if (ok !== this.ready) {
        this.log.info(ok ? "local decision model reachable" : "local decision model offline (using streamer fallback)", {
          model: this.cfg.model,
          url: this.cfg.url,
        });
      }
      this.ready = ok;
      this.checking = undefined;
      return ok;
    })();
    return this.checking;
  }

  /** Sub-300ms triage of a spoken utterance during live playback or idle. */
  async triageVoice(transcript: string, ctx: { speaking: boolean; busy: boolean }): Promise<VoiceTriage> {
    if (!(await this.check())) return "pass";
    const system =
      "/no_think\nClassify user voice input for a coding assistant. Reply ONLY single-line JSON {\"intent\":\"stop|noise|pass\"} with no markdown. " +
      "stop=user only tells the voice to stop/shut up/be quiet (no coding task). " +
      "noise=cough, filler, garbled 1-2 syllables. " +
      "pass=any question, instruction, feedback, confirmation, or unclear speech. " +
      "Examples: \"tais-toi\"->{\"intent\":\"stop\"}; \"euh\"->{\"intent\":\"noise\"}; \"ajoute un test\"->{\"intent\":\"pass\"}.";
    const user = `speaking=${ctx.speaking} busy=${ctx.busy} text=${JSON.stringify(transcript)}`;
    const json = await this.askJson<{ intent?: string }>(system, user);
    if (!json) return "pass";
    if (json.intent === "stop" || json.intent === "noise") return json.intent;
    return "pass";
  }

  /** Fast pre-filter for tool beats: skip pure noisy read/list bursts with no insight. */
  async triageBeat(summary: string): Promise<boolean> {
    if (!(await this.check())) return true;
    const system =
      "/no_think\nDecide if this tool-activity summary is worth speaking aloud briefly to the user, or too minor/repetitive to interrupt. " +
      "Reply ONLY single-line JSON {\"speak\":true|false} with no markdown.";
    const json = await this.askJson<{ speak?: boolean }>(system, summary.slice(0, 600));
    if (!json || typeof json.speak !== "boolean") return true;
    return json.speak;
  }

  private async askJson<T>(system: string, user: string): Promise<T | undefined> {
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          max_tokens: 48,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as T;
      const intent = cleaned.match(/"intent"\s*:\s*"(stop|noise|pass)"/i)?.[1]?.toLowerCase();
      if (intent) return { intent } as unknown as T;
      const speak = cleaned.match(/"speak"\s*:\s*(true|false)/i)?.[1]?.toLowerCase();
      if (speak) return { speak: speak === "true" } as unknown as T;
      return undefined;
    } catch {
      return undefined;
    }
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}
