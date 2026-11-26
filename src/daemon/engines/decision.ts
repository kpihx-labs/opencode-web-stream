import type { Config } from "../config.js";
import type { ScopedLogger } from "../log.js";

/**
 * Instant System-One decision gate backed by Ollaya (`largha` / `laya` ONNX
 * encoder models, TypeSafe `/v1/systemone` wire contract).
 *
 * Single forward pass, zero text generation, zero thinking: ~45 ms per
 * classification with calibrated `Choice` and `Noul` probabilities. When
 * offline, gracefully returns `pass` / `true` so the main `streamer` agent
 * handles everything without blocking.
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
    await this.askSystemOne(
      'speaking=false text="ok"',
      {
        intent: {
          type: "choice",
          instructions: "Warmup classification.",
          criteria: { stop: "stop", pass: "pass" },
        },
      },
      5000,
    );
  }

  /** ~45 ms calibrated triage of a spoken utterance via Ollaya System One. */
  async triageVoice(
    transcript: string,
    ctx: { speaking: boolean; busy: boolean; hasScreenAnswer?: boolean },
  ): Promise<VoiceTriage> {
    if (!(await this.check())) return "pass";
    const criteria: Record<string, string> = {
      noise: "Meaningless filler, cough, breath, or non-communicative noise (e.g. euh, hmm, uh) not directed at the assistant.",
      pass: "Any greeting, question, request, instruction, feedback, or meaningful speech directed at the assistant in any language.",
    };
    if (ctx.speaking) {
      criteria.stop =
        "The user is ONLY telling the currently speaking voice to stop talking, shut up, or pause, with no new task or question.";
    }
    const questions: Record<string, unknown> = {
      intent: {
        type: "choice",
        instructions: "Classify the user voice utterance while using a live coding assistant.",
        criteria,
      },
    };
    if (ctx.hasScreenAnswer) {
      questions.from_context = {
        type: "noul",
        instructions:
          "Is the user asking to present, summarize, zoom in on, explain, or discuss results/topics that were already found or displayed on screen (e.g. 'present only the LLM part', 'what did you find about X', 'explain that'), rather than asking to write code or launch a brand new external search?",
      };
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
    const t0 = Date.now();
    const res = await this.askSystemOne(summary.slice(0, 600), {
      worth_speaking: {
        type: "noul",
        instructions: "Is this tool-activity summary important or unexpected enough to interrupt and speak aloud to the developer, rather than routine file reading or listing?",
      },
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
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.model,
          state,
          questions,
        }),
        signal: AbortSignal.timeout(timeoutOverrideMs ?? this.cfg.timeoutMs),
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
