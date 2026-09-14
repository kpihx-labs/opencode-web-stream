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

export type AskResult = { text: string; aborted: boolean; timedOut: boolean; streamerID: string };

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
  summarizeEveryPrompts: number;
  titlePrefix?: string;
};

export class StreamerSession {
  private queue: Job[] = [];
  private inflight?: { job: Job; controller: AbortController };
  private ensuring?: Promise<string>;
  private readonly modelRef: ModelRef | undefined;
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
    this.modelRef = parseModel(opts.model);
  }

  setTitle(title: string) {
    this.mainTitle = title;
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
    const existing = this.registry.binding(this.mainSessionID);
    if (existing) {
      try {
        await this.client.getSession(existing.streamerID, existing.directory);
        this.hooks.onStreamerID(existing.streamerID);
        return existing.streamerID;
      } catch (e) {
        if (!(e instanceof OpencodeHttpError) || (e.status !== 404 && e.status !== 400)) throw e;
        this.log.warn("streamer session vanished, recreating", { main: this.mainSessionID, old: existing.streamerID });
        this.registry.unbind(this.mainSessionID);
      }
    }
    const title = `${this.opts.titlePrefix ?? "🎙 streamer"} · ${this.mainTitle || this.mainSessionID}`.slice(0, 120);
    const created = await this.client.createSession(this.directory, { title });
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
      model: this.modelRef,
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
        // Voice and blocked events jump the queue and preempt a running beat.
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
      const timer = setTimeout(() => controller.abort(new Error("timeout")), job.timeoutMs);
      try {
        const res = await this.client.prompt(
          streamerID,
          this.directory,
          { agent: this.opts.agent, model: this.modelRef, parts: [{ type: "text", text: job.prompt }] },
          { signal: controller.signal, timeoutMs: job.timeoutMs + 2000 },
        );
        clearTimeout(timer);
        const binding = this.registry.binding(this.mainSessionID);
        const prompts = (binding?.prompts ?? 0) + 1;
        this.registry.touch(this.mainSessionID, { prompts });
        job.resolve({ text: textOf(res?.parts), aborted: false, timedOut: false, streamerID });
        if (prompts % this.opts.summarizeEveryPrompts === 0) void this.compact(streamerID);
      } catch (e) {
        clearTimeout(timer);
        const reason = controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? "aborted") : "";
        if (reason) {
          // Stop the model on the server too; a preempted beat must not keep generating.
          this.client.abort(streamerID, this.directory).catch(() => undefined);
          job.resolve({ text: "", aborted: true, timedOut: reason === "timeout", streamerID });
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

  private async compact(streamerID: string) {
    if (!this.modelRef) return;
    try {
      await this.client.summarize(streamerID, this.directory, this.modelRef);
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
