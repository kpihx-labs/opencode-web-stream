import type { ModelRef } from "../../shared/opencode-events.js";
import type { ScopedLogger } from "../log.js";
import { OpencodeClient, OpencodeHttpError, parseModel, textOf } from "../opencode/client.js";
import type { Registry } from "./registry.js";

/**
 * One streamer session per main session, created on the OpenCode server with
 * the `streamer` agent. Requests are serialized: a voice turn preempts a beat
 * still in flight, and a newer beat replaces an older one that has not
 * started yet. The streamer never runs tools, so a prompt here is one model
 * call and nothing else.
 */

export type AskKind = "beat" | "voice" | "blocked" | "digest" | "context";

export type AskResult = { text: string; aborted: boolean; superseded?: boolean; timedOut: boolean; streamerID: string };

type Job = {
  kind: AskKind;
  prompt: string;
  timeoutMs: number;
  resolve: (r: AskResult | undefined) => void;
  onStart?: () => void;
};

export type StreamerOptions = {
  agent: string;
  model: string;
  /** Ordered list of "provider/model" candidates to try in order; empty = follow main session model. */
  models?: string[];
  mainModel?: ModelRef;
  summarizeEveryPrompts: number;
  titlePrefix?: string;
};

export class StreamerSession {
  private queue: Job[] = [];
  private inflight?: { job: Job; controller: AbortController };
  private ensuring?: Promise<string>;
  private readonly configuredModels: ModelRef[] = [];
  private mainModelRef: ModelRef | undefined;
  private appliedModelKey = "";
  private disposed = false;

  constructor(
    readonly mainSessionID: string,
    readonly directory: string,
    private mainTitle: string,
    private readonly client: OpencodeClient,
    private readonly registry: Registry,
    private readonly opts: StreamerOptions,
    private readonly log: ScopedLogger,
    private readonly hooks: { onStreamerID: (id: string) => void },
  ) {
    const rawList = (opts.models?.length ? opts.models : opts.model ? [opts.model] : [])
      .map((m) => parseModel(m))
      .filter((m): m is ModelRef => Boolean(m));
    this.configuredModels = rawList;
    this.mainModelRef = opts.mainModel;
  }

  private get candidateModels(): Array<ModelRef | undefined> {
    if (this.configuredModels.length > 0) return this.configuredModels;
    return [this.mainModelRef];
  }

  private get effectiveModel(): ModelRef | undefined {
    return this.configuredModels[0] ?? this.mainModelRef;
  }

  setTitle(title: string) {
    this.mainTitle = title;
  }

  setMainModel(model: ModelRef | undefined) {
    if (!model?.providerID || !model?.modelID) return;
    this.mainModelRef = model;
  }

  get streamerID(): string | undefined {
    return this.registry.binding(this.mainSessionID)?.streamerID;
  }

  /** Make sure a live streamer session exists on the server; returns its id. */
  ensure(): Promise<string> {
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<string> {
    const model = this.effectiveModel;
    const modelKey = model ? `${model.providerID}/${model.modelID}` : "";
    const existing = this.registry.binding(this.mainSessionID);
    if (existing) {
      try {
        const info = await this.client.getSession(existing.streamerID, existing.directory);
        if (info.agent !== this.opts.agent) {
          await this.client.setSessionAgent(existing.streamerID, existing.directory, this.opts.agent).catch(() => undefined);
        }
        if (model && this.appliedModelKey !== modelKey) {
          await this.client.setSessionModel(existing.streamerID, existing.directory, model).catch(() => undefined);
          this.appliedModelKey = modelKey;
        }
        this.hooks.onStreamerID(existing.streamerID);
        return existing.streamerID;
      } catch (e) {
        if (!(e instanceof OpencodeHttpError) || (e.status !== 404 && e.status !== 400)) throw e;
        this.log.warn("streamer session vanished, recreating", { main: this.mainSessionID, old: existing.streamerID });
        this.registry.unbind(this.mainSessionID);
      }
    }
    const title = `${this.opts.titlePrefix ?? "🎙 streamer"} · ${this.mainTitle || this.mainSessionID}`.slice(0, 120);
    const created = await this.client.createSession(this.directory, {
      title,
      agent: this.opts.agent,
      model,
    });
    if (modelKey) this.appliedModelKey = modelKey;
    this.registry.bind(this.mainSessionID, {
      streamerID: created.id,
      directory: this.directory,
      createdAt: Date.now(),
      prompts: 0,
      lastSeedAt: 0,
    });
    this.hooks.onStreamerID(created.id);
    this.log.info("streamer session created", { main: this.mainSessionID, streamer: created.id });
    return created.id;
  }

  /** Store context in the streamer without triggering a model call. */
  async seed(text: string): Promise<void> {
    const id = await this.ensure();
    await this.client.prompt(id, this.directory, {
      agent: this.opts.agent,
      model: this.effectiveModel,
      noReply: true,
      parts: [{ type: "text", text }],
    });
    this.registry.touch(this.mainSessionID, { lastSeedAt: Date.now() });
  }

  /**
   * Ask the streamer. Resolves with its text, or undefined when the request
   * was superseded, aborted, or timed out.
   */
  ask(kind: AskKind, prompt: string, timeoutMs: number, onStart?: () => void): Promise<AskResult | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const job: Job = { kind, prompt, timeoutMs, resolve, onStart };
      if (kind === "beat") {
        // Only the newest beat matters; older pending beats describe stale activity.
        for (const old of this.queue.filter((j) => j.kind === "beat")) old.resolve(undefined);
        this.queue = this.queue.filter((j) => j.kind !== "beat");
        this.queue.push(job);
      } else {
        // If a newer voice turn arrives while an earlier voice turn is waiting or stuck, supersede the stale turn.
        if (kind === "voice") {
          for (const old of this.queue.filter((j) => j.kind === "voice")) {
            old.resolve({ text: "", aborted: true, superseded: true, timedOut: false, streamerID: "" });
          }
          this.queue = this.queue.filter((j) => j.kind !== "voice");
          if (this.inflight?.job.kind === "voice") {
            this.inflight.controller.abort(new Error("superseded"));
          }
        }
        // Voice and blocked events jump the queue and preempt a running beat or digest.
        const idx = this.queue.findIndex((j) => j.kind === "beat");
        if (idx >= 0) this.queue.splice(idx, 0, job);
        else this.queue.push(job);
        if (this.inflight?.job.kind === "beat" || this.inflight?.job.kind === "digest") {
          this.inflight.controller.abort(new Error("preempted"));
        }
      }
      void this.pump();
    });
  }

  get busy(): boolean {
    return Boolean(this.inflight);
  }

  private async pump() {
    if (this.inflight || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    const controller = new AbortController();
    this.inflight = { job, controller };
    let streamerID = "";
    try {
      streamerID = await this.ensure();
      job.onStart?.();
      const timer = job.timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("timeout")), job.timeoutMs) : undefined;
      const candidates = this.candidateModels;
      let res: Awaited<ReturnType<OpencodeClient["prompt"]>> | undefined;
      let lastErr: unknown;
      let usedModel: ModelRef | undefined;
      try {
        for (let i = 0; i < candidates.length; i++) {
          if (controller.signal.aborted) break;
          const model = candidates[i];
          const modelKey = model ? `${model.providerID}/${model.modelID}` : "(session-default)";
          const t0 = Date.now();
          if (model && this.appliedModelKey !== `${model.providerID}/${model.modelID}`) {
            await this.client.setSessionModel(streamerID, this.directory, model).catch(() => undefined);
            this.appliedModelKey = `${model.providerID}/${model.modelID}`;
          }
          try {
            this.log.debug("streamer prompt start", {
              kind: job.kind,
              streamer: streamerID,
              model: modelKey,
              attempt: i + 1,
              total: candidates.length,
            });
            const attemptRes = await this.client.prompt(
              streamerID,
              this.directory,
              { agent: this.opts.agent, model, parts: [{ type: "text", text: job.prompt }] },
              { signal: controller.signal, timeoutMs: job.timeoutMs > 0 ? job.timeoutMs + 2000 : 0 },
            );
            const attemptText = textOf(attemptRes?.parts);
            if (!attemptText && i + 1 < candidates.length) {
              this.log.warn("streamer candidate returned empty text, trying next", { kind: job.kind, model: modelKey, elapsedMs: Date.now() - t0 });
              continue;
            }
            res = attemptRes;
            usedModel = model;
            this.log.debug("streamer prompt ok", {
              kind: job.kind,
              streamer: streamerID,
              model: modelKey,
              elapsedMs: Date.now() - t0,
              chars: attemptText.length,
            });
            break;
          } catch (err) {
            lastErr = err;
            if (controller.signal.aborted) throw err;
            this.log.warn("streamer candidate failed", {
              kind: job.kind,
              model: modelKey,
              attempt: i + 1,
              total: candidates.length,
              elapsedMs: Date.now() - t0,
              error: err instanceof Error ? err.message : String(err),
            });
            if (err instanceof OpencodeHttpError && (err.status === 404 || err.status === 400)) {
              this.registry.unbind(this.mainSessionID);
              streamerID = await this.ensure();
            }
          }
        }
        if (timer) clearTimeout(timer);
        if (!res) {
          throw lastErr ?? new Error("all streamer model candidates failed");
        }
        const binding = this.registry.binding(this.mainSessionID);
        const prompts = (binding?.prompts ?? 0) + 1;
        this.registry.touch(this.mainSessionID, { prompts });
        job.resolve({ text: textOf(res?.parts), aborted: false, timedOut: false, streamerID });
        if (prompts % this.opts.summarizeEveryPrompts === 0) void this.compact(streamerID, usedModel);
      } catch (e) {
        if (timer) clearTimeout(timer);
        const reason = controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? "aborted") : "";
        if (reason) {
          // Stop the model on the server too; a preempted beat must not keep generating.
          this.client.abort(streamerID, this.directory).catch(() => undefined);
          job.resolve({ text: "", aborted: true, superseded: reason === "superseded", timedOut: reason === "timeout", streamerID });
          this.log.debug("streamer request aborted", { kind: job.kind, reason });
        } else {
          this.log.warn("streamer request failed", { kind: job.kind, error: e instanceof Error ? e.message : String(e) });
          if (e instanceof OpencodeHttpError && (e.status === 404 || e.status === 400)) this.registry.unbind(this.mainSessionID);
          job.resolve(undefined);
        }
      }
    } catch (e) {
      this.log.error("streamer unavailable", { error: e instanceof Error ? e.message : String(e) });
      job.resolve(undefined);
    } finally {
      this.inflight = undefined;
      void this.pump();
    }
  }

  private async compact(streamerID: string, preferredModel?: ModelRef) {
    const model = preferredModel ?? this.effectiveModel;
    if (!model) return;
    try {
      await this.client.summarize(streamerID, this.directory, model);
      this.log.info("streamer session summarized", { streamer: streamerID });
    } catch (e) {
      this.log.warn("streamer summarize failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Drop pending beats (e.g. the user started talking). */
  dropBeats() {
    for (const j of this.queue.filter((j) => j.kind === "beat")) j.resolve(undefined);
    this.queue = this.queue.filter((j) => j.kind !== "beat");
    if (this.inflight?.job.kind === "beat") this.inflight.controller.abort(new Error("preempted"));
  }

  dispose() {
    this.disposed = true;
    for (const j of this.queue) j.resolve(undefined);
    this.queue = [];
    this.inflight?.controller.abort(new Error("disposed"));
  }
}
