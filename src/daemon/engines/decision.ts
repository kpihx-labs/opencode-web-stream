import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";

/**
 * Instant System-One decision gate backed by Ollaya (`largha` / `laya` ONNX
 * encoder models, TypeSafe `/v1/systemone` wire contract).
 *
 * Prompt specifications live externally in `agent/decision.prompt.json` — zero
 * prompt prose is hardcoded in TypeScript.
 */

export type VoiceTriage = "stop" | "noise" | "answer_from_context" | "pass";

type ChoiceAnswer = {
  type: "choice";
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type NoulAnswer = {
  type: "noul";
  noul?: number;
};

type SystemOneResponse = {
  answers?: Record<string, ChoiceAnswer | NoulAnswer>;
};

type DecisionPrompts = {
  warmup: { intent: { type: string; instructions: string; criteria: Record<string, string> } };
  voice: {
    instructions: string;
    criteria: { stop: string; noise: string; pass: string };
    fromContext: { type: string; instructions: string };
  };
  beat: { worthSpeaking: { type: string; instructions: string } };
};

let cachedPrompts: DecisionPrompts | undefined;

function loadDecisionPrompts(): DecisionPrompts {
  if (cachedPrompts) return cachedPrompts;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "agent", "decision.prompt.json");
    if (existsSync(candidate)) {
      cachedPrompts = JSON.parse(readFileSync(candidate, "utf8")) as DecisionPrompts;
      return cachedPrompts;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("missing agent/decision.prompt.json");
}

export class DecisionEngine {
  private ready = false;
  private warmed = false;
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
      for (const probe of [`${origin}/v1/models`, `${origin}/`]) {
        try {
          const res = await this.fetchImpl(probe, { signal: AbortSignal.timeout(1200) });
          if (res.ok) {
            ok = true;
            break;
          }
        } catch {
          // next probe
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
      if (ok && !this.warmed) {
        this.warmed = true;
        void this.warmup();
      }
      this.checking = undefined;
      return ok;
    })();
    return this.checking;
  }

  private async warmup() {
    const prompts = loadDecisionPrompts();
    await this.askSystemOne('speaking=false text="ok"', prompts.warmup);
  }

  /** ~45 ms calibrated triage of a spoken utterance via Ollaya System One. */
  async triageVoice(
    transcript: string,
    ctx: { speaking: boolean; busy: boolean; hasScreenAnswer?: boolean },
  ): Promise<VoiceTriage> {
    if (!(await this.check())) return "pass";
    const prompts = loadDecisionPrompts();
    const criteria: Record<string, string> = {
      noise: prompts.voice.criteria.noise,
      pass: prompts.voice.criteria.pass,
    };
    if (ctx.speaking) {
      criteria.stop = prompts.voice.criteria.stop;
    }
    const questions: Record<string, unknown> = {
      intent: {
        type: "choice",
        instructions: prompts.voice.instructions,
        criteria,
      },
    };
    if (ctx.hasScreenAnswer) {
      questions.from_context = prompts.voice.fromContext;
    }
    const t0 = Date.now();
    const res = await this.askSystemOne(
      `speaking=${ctx.speaking} busy=${ctx.busy} has_results_on_screen=${Boolean(ctx.hasScreenAnswer)} text=${JSON.stringify(transcript)}`,
      questions,
    );
    const ans = res?.answers?.intent as ChoiceAnswer | undefined;
    if (!ans || ans.type !== "choice") {
      this.log.debug("largha voice triage fallback", { elapsedMs: Date.now() - t0, text: transcript.slice(0, 80) });
      return "pass";
    }
    const probs = ans.probabilities ?? {};
    const passProb = probs.pass ?? 0;
    let decision: VoiceTriage = "pass";
    if (ctx.speaking && ans.choice === "stop" && (probs.stop ?? 0) >= 0.5 && (probs.stop ?? 0) - passProb >= 0.12) {
      decision = "stop";
    } else if (ans.choice === "noise" && (probs.noise ?? 0) >= 0.5 && (probs.noise ?? 0) - passProb >= 0.12) {
      decision = "noise";
    } else {
      const fromCtx = res?.answers?.from_context as NoulAnswer | undefined;
      if (ctx.hasScreenAnswer && fromCtx?.type === "noul" && typeof fromCtx.noul === "number" && fromCtx.noul >= 0.5) {
        decision = "answer_from_context";
      }
    }
    this.log.debug("largha voice triage", {
      decision,
      choice: ans.choice,
      probs,
      fromContext: (res?.answers?.from_context as NoulAnswer | undefined)?.noul,
      elapsedMs: Date.now() - t0,
      text: transcript.slice(0, 80),
    });
    return decision;
  }

  /** ~45 ms calibrated salience gate for short tool-activity beats. */
  async triageBeat(summary: string): Promise<boolean> {
    if (!(await this.check())) return true;
    const prompts = loadDecisionPrompts();
    const t0 = Date.now();
    const res = await this.askSystemOne(summary.slice(0, 600), {
      worth_speaking: prompts.beat.worthSpeaking,
    });
    const ans = res?.answers?.worth_speaking as NoulAnswer | undefined;
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return true;
    const speak = ans.noul >= 0.3;
    this.log.debug("largha beat triage", { speak, noul: ans.noul, elapsedMs: Date.now() - t0 });
    return speak;
  }

  private async askSystemOne(
    state: string,
    questions: Record<string, unknown>,
    timeoutOverrideMs?: number,
  ): Promise<SystemOneResponse | undefined> {
    const ms = timeoutOverrideMs ?? this.cfg.timeoutMs;
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          state,
          questions,
        }),
        ...(ms > 0 ? { signal: AbortSignal.timeout(ms) } : {}),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as SystemOneResponse;
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
