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

export type VoiceTriage = "stop" | "noise" | "pass";

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
  async triageVoice(transcript: string, ctx: { speaking: boolean; busy: boolean }): Promise<VoiceTriage> {
    if (!(await this.check())) return "pass";
    const res = await this.askSystemOne(`speaking=${ctx.speaking} busy=${ctx.busy} text=${JSON.stringify(transcript)}`, {
      intent: {
        type: "choice",
        instructions: "Classify the user voice utterance while using a live coding assistant.",
        criteria: {
          stop: "The user ONLY tells the voice/assistant to stop talking, shut up, pause, or be quiet (e.g. tais-toi, stop, arrete, shut up), with no coding instruction.",
          noise: "Meaningless filler, cough, breath, garbled syllable (e.g. euh, hmm, uh) not meant as communication.",
          pass: "A greeting, question, instruction, feedback, answer, or anything directed at the assistant (e.g. bonjour, ajoute un test, ok).",
        },
      },
    });
    const ans = res?.answers?.intent as ChoiceAnswer | undefined;
    if (!ans || ans.type !== "choice") return "pass";
    const probs = ans.probabilities ?? {};
    if (ans.choice === "stop" && (probs.stop ?? 0) >= 0.4) return "stop";
    if (ans.choice === "noise" && (probs.noise ?? 0) >= 0.42) return "noise";
    return "pass";
  }

  /** ~45 ms calibrated salience gate for short tool-activity beats. */
  async triageBeat(summary: string): Promise<boolean> {
    if (!(await this.check())) return true;
    const res = await this.askSystemOne(summary.slice(0, 600), {
      worth_speaking: {
        type: "noul",
        instructions: "Is this tool-activity summary important or unexpected enough to interrupt and speak aloud to the developer, rather than routine file reading or listing?",
      },
    });
    const ans = res?.answers?.worth_speaking as NoulAnswer | undefined;
    if (!ans || ans.type !== "noul" || typeof ans.noul !== "number") return true;
    return ans.noul >= 0.4;
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
