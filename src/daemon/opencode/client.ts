import type {
  GlobalEnvelope,
  MessageInfo,
  ModelRef,
  Part,
  PermissionReply,
  PromptBody,
  SessionInfo,
  SessionStatus,
  ToolStatus,
} from "../../shared/opencode-events.js";
import type { ScopedLogger } from "../log.js";

/**
 * Dual-protocol client for OpenCode HTTP server (supports both V2 `/api/*`
 * + `/api/event` and legacy V1 `/session/*` + `/global/event`).
 */

export type WithParts = { info: MessageInfo; parts: Part[] };
export type Project = { id: string; worktree: string; name?: string };
export type FetchLike = typeof fetch;
export type ApiMode = "auto" | "v1" | "v2";

export class OpencodeHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    body: string,
  ) {
    super(`${method} ${path} -> HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export type ClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  apiMode?: ApiMode;
  fetch?: FetchLike;
  log?: ScopedLogger;
  defaultTimeoutMs?: number;
};

export class OpencodeClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly auth?: string;
  private readonly log?: ScopedLogger;
  private readonly defaultTimeoutMs: number;
  private mode: "v1" | "v2" | undefined;
  private probing?: Promise<"v1" | "v2">;
  private readonly v2TextSeen = new Map<string, number>();
  private readonly v2TextBuffers = new Map<string, string>();

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.log = opts.log;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15000;
    if (opts.apiMode === "v1" || opts.apiMode === "v2") {
      this.mode = opts.apiMode;
    }
    if (opts.password) {
      const user = opts.username || "opencode";
      this.auth = `Basic ${Buffer.from(`${user}:${opts.password}`).toString("base64")}`;
    }
  }

  headers(directory?: string, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.auth) h.authorization = this.auth;
    if (directory) h["x-opencode-directory"] = directory;
    return h;
  }

  async resolveMode(): Promise<"v1" | "v2"> {
    if (this.mode) return this.mode;
    if (this.probing) return this.probing;
    this.probing = (async () => {
      try {
        await this.request<unknown>("GET", "/api/info", { timeoutMs: 2500 });
        this.mode = "v2";
      } catch {
        this.mode = "v1";
      }
      this.probing = undefined;
      this.log?.info("detected opencode API mode", { mode: this.mode });
      return this.mode;
    })();
    return this.probing;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { directory?: string; body?: unknown; query?: Record<string, string | number | undefined>; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs) : undefined;
    const onOuterAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(opts.directory, opts.body === undefined ? {} : { "content-type": "application/json" }),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new OpencodeHttpError(res.status, method, path, text);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // ---- sessions -----------------------------------------------------------

  async createSession(directory: string, body: { title?: string; parentID?: string; agent?: string; model?: ModelRef } = {}): Promise<SessionInfo> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<{ data?: Record<string, unknown> }>("POST", "/api/session", {
        directory,
        body: {
          title: body.title,
          parentID: body.parentID,
          agent: body.agent,
          model: body.model ? { providerID: body.model.providerID, id: body.model.modelID } : undefined,
          location: directory ? { directory } : undefined,
        },
      });
      return normalizeV2Session(raw.data ?? (raw as Record<string, unknown>), directory);
    }
    return this.request<SessionInfo>("POST", "/session", { directory, body });
  }

  async getSession(sessionID: string, directory: string): Promise<SessionInfo> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<{ data?: Record<string, unknown> }>("GET", `/api/session/${encodeURIComponent(sessionID)}`, { directory });
      return normalizeV2Session(raw.data ?? (raw as Record<string, unknown>), directory);
    }
    return this.request<SessionInfo>("GET", `/session/${encodeURIComponent(sessionID)}`, { directory });
  }

  async setSessionAgent(sessionID: string, directory: string, agent: string): Promise<void> {
    if ((await this.resolveMode()) !== "v2") return;
    await this.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionID)}/agent`, {
      directory,
      body: { agent },
    });
  }

  async setSessionModel(sessionID: string, directory: string, model: ModelRef): Promise<void> {
    if ((await this.resolveMode()) !== "v2") return;
    await this.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, {
      directory,
      body: { model: { providerID: model.providerID, id: model.modelID } },
    });
  }

  async listSessions(directory: string): Promise<SessionInfo[]> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<{ data?: Array<Record<string, unknown>> }>("GET", "/api/session", { directory });
      return (raw.data ?? []).map((s) => normalizeV2Session(s, directory));
    }
    return this.request<SessionInfo[]>("GET", "/session", { directory });
  }

  async listProjects(): Promise<Project[]> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<Array<Record<string, unknown>>>("GET", "/api/project");
      return (Array.isArray(raw) ? raw : []).map((p) => ({
        id: String(p.id ?? ""),
        worktree: String(p.canonical ?? p.worktree ?? ""),
        name: typeof p.name === "string" ? p.name : undefined,
      }));
    }
    return this.request<Project[]>("GET", "/project");
  }

  async messages(sessionID: string, directory: string, limit = 20): Promise<WithParts[]> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<{ data?: Array<Record<string, unknown>> }>(
        "GET",
        `/api/session/${encodeURIComponent(sessionID)}/message`,
        { directory, query: { limit } },
      );
      return (raw.data ?? [])
        .map((m) => normalizeV2Message(m, sessionID))
        .sort((a, b) => a.info.time.created - b.info.time.created);
    }
    return this.request<WithParts[]>("GET", `/session/${encodeURIComponent(sessionID)}/message`, {
      directory,
      query: { limit },
    });
  }

  async sessionStatus(directory: string): Promise<Record<string, SessionStatus>> {
    if ((await this.resolveMode()) === "v2") {
      const raw = await this.request<{ data?: Record<string, { type?: string; status?: string }> } | Record<string, { type?: string; status?: string }>>(
        "GET",
        "/api/session/active",
        { directory },
      );
      const map = (raw && typeof raw === "object" && "data" in raw && raw.data && typeof raw.data === "object"
        ? raw.data
        : raw) as Record<string, { type?: string; status?: string }>;
      const out: Record<string, SessionStatus> = {};
      for (const [id, v] of Object.entries(map ?? {})) {
        const state = v?.type ?? v?.status;
        out[id] = { type: state === "busy" || state === "running" ? "busy" : "idle" };
      }
      return out;
    }
    return this.request<Record<string, SessionStatus>>("GET", "/session/status", { directory });
  }

  /** Synchronous prompt: resolves with the assistant message once the turn ends. */
  async prompt(sessionID: string, directory: string, body: PromptBody, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WithParts> {
    if ((await this.resolveMode()) === "v2") {
      const text = body.parts.map((p) => p.text).join("\n").trim();
      if (body.noReply) {
        const raw = await this.request<{ data?: Record<string, unknown> }>("POST", `/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
          directory,
          body: { text, resume: false },
          timeoutMs: opts.timeoutMs ?? 30000,
          signal: opts.signal,
        });
        return normalizeV2Message(raw?.data ?? { id: "", type: "synthetic", content: [] }, sessionID);
      }
      const before = await this.messages(sessionID, directory, 10).catch(() => []);
      const seenIds = new Set(before.map((m) => m.info.id));
      const fallbackStart = Date.now() - 250;
      const promptRes = await this.request<{ data?: { time?: { created?: number } } }>(
        "POST",
        `/api/session/${encodeURIComponent(sessionID)}/prompt`,
        {
          directory,
          body: { text },
          timeoutMs: opts.timeoutMs === 0 ? 0 : (opts.timeoutMs ?? 120000),
          signal: opts.signal,
        },
      );
      const promptCreatedAt =
        typeof promptRes?.data?.time?.created === "number" ? promptRes.data.time.created : fallbackStart;
      // Poll briefly for the completed assistant text reply created by this prompt.
      // Never return early on an intermediate tool-call step with empty text while busy.
      const deadline = opts.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + (opts.timeoutMs ?? 20000);
      while (Date.now() < deadline && !opts.signal?.aborted) {
        const latest = await this.messages(sessionID, directory, 8).catch(() => []);
        const reply = [...latest]
          .reverse()
          .find(
            (m) =>
              m.info.role === "assistant" &&
              !seenIds.has(m.info.id) &&
              m.info.time.created >= promptCreatedAt &&
              m.info.time.completed &&
              textOf(m.parts).length > 0,
          );
        if (reply) return reply;
        const status = await this.sessionStatus(directory).catch(() => ({} as Record<string, SessionStatus>));
        if (status[sessionID]?.type === "idle") {
          const anyCompleted = [...latest]
            .reverse()
            .find(
              (m) =>
                m.info.role === "assistant" &&
                !seenIds.has(m.info.id) &&
                m.info.time.created >= promptCreatedAt &&
                m.info.time.completed,
            );
          if (anyCompleted) return anyCompleted;
        }
        await sleep(60, opts.signal);
      }
      const fallback = (await this.messages(sessionID, directory, 4).catch(() => []))
        .reverse()
        .find((m) => m.info.role === "assistant" && !seenIds.has(m.info.id) && m.info.time.created >= promptCreatedAt && m.parts.length > 0);
      if (!fallback) throw new Error("opencode prompt timed out waiting for assistant reply");
      return fallback;
    }

    return this.request<WithParts>("POST", `/session/${encodeURIComponent(sessionID)}/message`, {
      directory,
      body,
      timeoutMs: opts.timeoutMs ?? 120000,
      signal: opts.signal,
    });
  }

  /** Queue a prompt and return immediately. Queues behind a running turn. */
  async promptAsync(sessionID: string, directory: string, body: PromptBody): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      const text = body.parts.map((p) => p.text).join("\n").trim();
      await this.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        directory,
        body: {
          text,
          agent: body.agent,
          model: body.model ? { providerID: body.model.providerID, id: body.model.modelID } : undefined,
        },
      });
      return;
    }
    await this.request<void>("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, { directory, body });
  }

  async abort(sessionID: string, directory: string): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      await this.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`, {
        directory,
        body: {},
      });
      return;
    }
    await this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/abort`, { directory });
  }

  async summarize(sessionID: string, directory: string, model: ModelRef): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      await this.request<unknown>("POST", `/api/session/${encodeURIComponent(sessionID)}/compact`, {
        directory,
        body: {},
        timeoutMs: 120000,
      });
      return;
    }
    await this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/summarize`, {
      directory,
      body: { providerID: model.providerID, modelID: model.modelID },
      timeoutMs: 120000,
    });
  }

  // ---- permissions & questions -------------------------------------------

  async respondPermission(sessionID: string, directory: string, permissionID: string, response: PermissionReply): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      await this.request<unknown>(
        "POST",
        `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`,
        { directory, body: { decision: response } },
      );
      return;
    }
    try {
      await this.request<boolean>(
        "POST",
        `/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}`,
        { directory, body: { response } },
      );
    } catch (e) {
      if (!(e instanceof OpencodeHttpError) || e.status !== 404) throw e;
      await this.request<boolean>("POST", `/permission/${encodeURIComponent(permissionID)}/reply`, {
        directory,
        body: { reply: response },
      });
    }
  }

  async replyQuestion(directory: string, requestID: string, answers: string[][], sessionID = ""): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      if (!sessionID) return;
      const answer: Record<string, string | string[]> = {};
      answers.forEach((vals, idx) => {
        answer[String(idx)] = vals.length <= 1 ? vals[0] ?? "" : vals;
      });
      await this.request<unknown>(
        "POST",
        `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}/reply`,
        { directory, body: { answer } },
      );
      return;
    }
    await this.request<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reply`, {
      directory,
      body: { answers },
    });
  }

  async rejectQuestion(directory: string, requestID: string, sessionID = ""): Promise<void> {
    if ((await this.resolveMode()) === "v2") {
      if (!sessionID) return;
      await this.request<unknown>(
        "DELETE",
        `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(requestID)}`,
        { directory },
      );
      return;
    }
    await this.request<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reject`, { directory });
  }

  async health(): Promise<boolean> {
    const mode = await this.resolveMode();
    try {
      await this.request<unknown>("GET", mode === "v2" ? "/api/info" : "/global/health", { timeoutMs: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- events -------------------------------------------------------------

  /**
   * Subscribe to `/api/event` (V2) or `/global/event` (V1) with automatic
   * reconnection. Translates V2 events into normalized `GlobalEnvelope`s.
   */
  async subscribeGlobal(
    onEvent: (envelope: GlobalEnvelope) => void,
    hooks: { signal: AbortSignal; onOpen?: () => void; onClose?: (err?: Error) => void; idleTimeoutMs?: number },
  ): Promise<void> {
    let backoff = 500;
    const idleTimeoutMs = hooks.idleTimeoutMs ?? 40000;
    while (!hooks.signal.aborted) {
      const mode = await this.resolveMode();
      const ssePath = mode === "v2" ? "/api/event" : "/global/event";
      const attempt = new AbortController();
      const stop = () => attempt.abort(new Error("stopped"));
      hooks.signal.addEventListener("abort", stop, { once: true });
      let idleTimer: NodeJS.Timeout | undefined;
      const bump = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => attempt.abort(new Error("sse idle")), idleTimeoutMs);
      };
      try {
        const res = await this.fetchImpl(this.baseUrl + ssePath, {
          headers: this.headers(undefined, { accept: "text/event-stream" }),
          signal: attempt.signal,
        });
        if (!res.ok || !res.body) {
          throw new OpencodeHttpError(res.status, "GET", ssePath, await res.text().catch(() => ""));
        }
        backoff = 500;
        hooks.onOpen?.();
        bump();
        for await (const data of readSse(res.body)) {
          bump();
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          for (const env of this.translateEvent(parsed)) {
            onEvent(env);
          }
        }
        hooks.onClose?.();
      } catch (err) {
        if (hooks.signal.aborted) break;
        const e = err instanceof Error ? err : new Error(String(err));
        this.log?.warn("sse disconnected", { error: e.message, retryMs: backoff });
        hooks.onClose?.(e);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        hooks.signal.removeEventListener("abort", stop);
      }
      if (hooks.signal.aborted) break;
      await sleep(backoff, hooks.signal);
      backoff = Math.min(backoff * 2, 10000);
    }
  }

  private translateEvent(raw: unknown): GlobalEnvelope[] {
    const v1 = normalizeEnvelope(raw);
    if (v1) return [v1];
    if (!raw || typeof raw !== "object") return [];
    const obj = raw as Record<string, unknown>;
    if (typeof obj.type !== "string" || !("data" in obj)) return [];
    const data = (obj.data ?? {}) as Record<string, unknown>;
    const loc = (obj.location ?? data.location ?? {}) as Record<string, unknown>;
    const directory = typeof loc.directory === "string" ? loc.directory : "";
    const created = typeof obj.created === "number" ? obj.created : Date.now();
    const out: GlobalEnvelope[] = [];
    const emit = (type: string, properties: unknown) => {
      out.push({ directory, payload: { id: obj.id as string | undefined, type, properties } });
    };

    switch (obj.type) {
      case "server.connected":
      case "server.heartbeat":
        emit(obj.type, {});
        break;
      case "session.created":
      case "session.updated":
      case "session.renamed":
      case "session.agent.selected":
      case "session.model.selected":
      case "session.moved": {
        const info = normalizeV2Session({ ...data, id: data.sessionID, time: { created, updated: created } }, directory);
        emit(obj.type === "session.created" ? "session.created" : "session.updated", { info });
        break;
      }
      case "session.deleted": {
        const info = normalizeV2Session({ ...data, id: data.sessionID }, directory);
        emit("session.deleted", { info });
        break;
      }
      case "session.status": {
        const st = (data.status ?? {}) as { type?: string; attempt?: number; message?: string; next?: number };
        const type = st.type === "running" || st.type === "busy" ? "busy" : st.type === "retry" ? "retry" : "idle";
        emit("session.status", { sessionID: data.sessionID, status: { ...st, type } });
        break;
      }
      case "session.idle":
        emit("session.idle", { sessionID: data.sessionID });
        break;
      case "session.execution.started":
        emit("session.status", { sessionID: data.sessionID, status: { type: "busy" } });
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        emit("session.status", { sessionID: data.sessionID, status: { type: "idle" } });
        emit("session.idle", { sessionID: data.sessionID });
        break;
      case "session.execution.failed":
        emit("session.error", { sessionID: data.sessionID, error: data.error });
        break;
      case "session.retry.scheduled": {
        const err = (data.error ?? {}) as { message?: string; data?: { message?: string } };
        emit("session.status", {
          sessionID: data.sessionID,
          status: {
            type: "retry",
            attempt: Number(data.attempt ?? 1),
            message: err.message ?? err.data?.message ?? "retry scheduled",
            next: typeof data.at === "number" ? data.at : undefined,
          },
        });
        break;
      }
      case "session.compaction.ended":
        emit("session.compacted", { sessionID: data.sessionID });
        break;
      case "session.inbox.enqueued": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.inboxID ?? "");
        const item = (data.item ?? {}) as { type?: string; payload?: { text?: unknown } };
        if (item.type === "user" && typeof item.payload?.text === "string") {
          emit("message.updated", {
            info: { id: messageID, sessionID, role: "user", time: { created } },
          });
          emit("message.part.updated", {
            part: { id: `${messageID}:0`, sessionID, messageID, type: "text", text: item.payload.text },
          });
        }
        break;
      }
      case "session.text.started": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.assistantMessageID ?? "");
        const partID = `${messageID}:text`;
        const key = `${sessionID}:${partID}`;
        if (!this.v2TextBuffers.has(key)) this.v2TextBuffers.set(key, "");
        emit("message.part.updated", { part: { id: partID, sessionID, messageID, type: "text", text: this.v2TextBuffers.get(key) ?? "" } });
        break;
      }
      case "session.text.delta": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.assistantMessageID ?? "");
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (!delta) break;
        const partID = `${messageID}:text`;
        const key = `${sessionID}:${partID}`;
        const next = (this.v2TextBuffers.get(key) ?? "") + delta;
        this.v2TextBuffers.set(key, next);
        this.v2TextSeen.set(key, next.length);
        emit("message.part.updated", { part: { id: partID, sessionID, messageID, type: "text", text: next } });
        emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta });
        break;
      }
      case "session.text.ended": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.assistantMessageID ?? "");
        const text = typeof data.text === "string" ? data.text : "";
        const partID = `${messageID}:text`;
        const key = `${sessionID}:${partID}`;
        const prev = this.v2TextSeen.get(key) ?? 0;
        this.v2TextBuffers.set(key, text);
        emit("message.part.updated", { part: { id: partID, sessionID, messageID, type: "text", text } });
        if (text.length > prev) {
          const delta = text.slice(prev);
          this.v2TextSeen.set(key, text.length);
          emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta });
        }
        break;
      }
      case "session.message.content.updated": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.messageID ?? "");
        const content = Array.isArray(data.content) ? (data.content as Array<Record<string, unknown>>) : [];
        const textChunks: string[] = [];
        content.forEach((item, idx) => {
          if (item.type === "text" && typeof item.text === "string") {
            textChunks.push(item.text);
          } else if (item.type === "tool") {
            emit("message.part.updated", { part: normalizeV2Tool(item, sessionID, messageID, idx) });
          }
        });
        if (textChunks.length > 0) {
          const fullText = textChunks.join("\n");
          const partID = `${messageID}:text`;
          const key = `${sessionID}:${partID}`;
          const prev = this.v2TextSeen.get(key) ?? 0;
          this.v2TextBuffers.set(key, fullText);
          emit("message.part.updated", { part: { id: partID, sessionID, messageID, type: "text", text: fullText } });
          if (fullText.length > prev) {
            const delta = fullText.slice(prev);
            this.v2TextSeen.set(key, fullText.length);
            emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta });
          }
        }
        break;
      }
      case "session.tool.called":
      case "session.tool.success":
      case "session.tool.failed": {
        const sessionID = String(data.sessionID ?? "");
        const messageID = String(data.assistantMessageID ?? "");
        const callID = String(data.id ?? "");
        const status: ToolStatus = obj.type === "session.tool.called" ? "running" : obj.type === "session.tool.success" ? "completed" : "error";
        emit("message.part.updated", {
          part: {
            id: `${messageID}:${callID}`,
            sessionID,
            messageID,
            type: "tool",
            tool: String((data.native as { name?: string })?.name ?? data.tool ?? "tool"),
            callID,
            state: {
              status,
              input: (data.input as Record<string, unknown>) ?? undefined,
              output: Array.isArray(data.content) ? JSON.stringify(data.content) : undefined,
              error: data.error ? JSON.stringify(data.error) : undefined,
            },
          },
        });
        break;
      }
      case "permission.asked":
      case "permission.requested":
        emit("permission.asked", {
          id: data.id,
          sessionID: data.sessionID,
          permission: data.action ?? "permission",
          patterns: Array.isArray(data.resources) ? data.resources : [],
          metadata: data.metadata ?? {},
          always: Array.isArray(data.save) ? data.save : [],
        });
        break;
      case "permission.replied":
        emit("permission.replied", {
          sessionID: data.sessionID,
          requestID: data.requestID,
          reply: data.reply,
        });
        break;
      case "form.created": {
        const form = (data.form ?? {}) as Record<string, unknown>;
        const fields = Array.isArray(form.fields) ? (form.fields as Array<Record<string, unknown>>) : [];
        emit("question.asked", {
          id: form.id,
          sessionID: form.sessionID,
          questions: fields.map((f) => ({
            question: String(f.label ?? f.title ?? form.title ?? ""),
            header: String(f.id ?? ""),
            options: Array.isArray(f.options)
              ? (f.options as Array<Record<string, unknown>>).map((o) => ({
                  label: String(o.label ?? o.value ?? ""),
                  description: String(o.description ?? ""),
                }))
              : [],
            multiple: f.type === "multiselect",
            custom: true,
          })),
        });
        break;
      }
      case "form.replied":
        emit("question.replied", { sessionID: data.sessionID, requestID: data.id, answers: [] });
        break;
      case "form.cancelled":
        emit("question.rejected", { sessionID: data.sessionID, requestID: data.id });
        break;
      case "filesystem.changed":
        emit("file.edited", { file: data.file });
        break;
      case "vcs.branch.updated":
        emit("vcs.branch.updated", { branch: data.branch });
        break;
    }
    return out;
  }
}

function normalizeV2Session(raw: Record<string, unknown>, fallbackDir: string): SessionInfo {
  const loc = (raw.location ?? {}) as Record<string, unknown>;
  const time = (raw.time ?? {}) as Record<string, unknown>;
  const rawModel = (raw.model ?? {}) as { providerID?: unknown; modelID?: unknown; id?: unknown };
  const model =
    typeof rawModel.providerID === "string" && typeof (rawModel.modelID ?? rawModel.id) === "string"
      ? { providerID: rawModel.providerID, modelID: String(rawModel.modelID ?? rawModel.id) }
      : undefined;
  return {
    id: String(raw.id ?? raw.sessionID ?? ""),
    title: String(raw.title ?? ""),
    directory: String(loc.directory ?? raw.directory ?? fallbackDir ?? ""),
    parentID: typeof raw.parentID === "string" ? raw.parentID : undefined,
    agent: typeof raw.agent === "string" ? raw.agent : undefined,
    model,
    version: String(raw.version ?? "2"),
    time: {
      created: typeof time.created === "number" ? time.created : Date.now(),
      updated: typeof time.updated === "number" ? time.updated : Date.now(),
    },
  };
}

function normalizeV2Tool(item: Record<string, unknown>, sessionID: string, messageID: string, idx: number): Part {
  const callID = String(item.id ?? idx);
  const rawState = (item.state ?? {}) as Record<string, unknown>;
  const status = (rawState.status ?? (item.error ? "error" : item.output ? "completed" : "running")) as ToolStatus;
  return {
    id: `${messageID}:${callID}`,
    sessionID,
    messageID,
    type: "tool",
    tool: String(item.tool ?? item.name ?? "tool"),
    callID,
    state: {
      status,
      input: (item.input ?? rawState.input) as Record<string, unknown> | undefined,
      output: typeof item.output === "string" ? item.output : typeof rawState.output === "string" ? rawState.output : undefined,
      error: typeof item.error === "string" ? item.error : typeof rawState.error === "string" ? rawState.error : undefined,
    },
  };
}

function normalizeV2Message(raw: Record<string, unknown>, sessionID: string): WithParts {
  const id = String(raw.id ?? "");
  const role: "user" | "assistant" = raw.type === "user" || raw.role === "user" ? "user" : "assistant";
  const time = (raw.time ?? {}) as Record<string, unknown>;
  const rawModel = (raw.model ?? {}) as { providerID?: unknown; modelID?: unknown; id?: unknown };
  const model =
    typeof rawModel.providerID === "string" && typeof (rawModel.modelID ?? rawModel.id) === "string"
      ? { providerID: rawModel.providerID, modelID: String(rawModel.modelID ?? rawModel.id) }
      : undefined;
  const parts: Part[] = [];
  if (typeof raw.text === "string") {
    parts.push({ id: `${id}:text`, sessionID, messageID: id, type: "text", text: raw.text });
  }
  if (Array.isArray(raw.content)) {
    const textChunks: string[] = [];
    (raw.content as Array<Record<string, unknown>>).forEach((c, idx) => {
      if (c.type === "text" && typeof c.text === "string") {
        textChunks.push(c.text);
      } else if (c.type === "tool") {
        parts.push(normalizeV2Tool(c, sessionID, id, idx));
      }
    });
    if (textChunks.length > 0) {
      parts.push({ id: `${id}:text`, sessionID, messageID: id, type: "text", text: textChunks.join("\n") });
    }
  }
  return {
    info: {
      id,
      sessionID,
      role,
      agent: typeof raw.agent === "string" ? raw.agent : undefined,
      model,
      time: {
        created: typeof time.created === "number" ? time.created : Date.now(),
        completed: typeof time.completed === "number" ? time.completed : undefined,
      },
    },
    parts,
  };
}

/** Accept both `{directory, payload}` envelopes and V1 bare `{type, properties}` events. */
export function normalizeEnvelope(raw: unknown): GlobalEnvelope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.payload && typeof obj.payload === "object") {
    const payload = obj.payload as Record<string, unknown>;
    if (typeof payload.type !== "string") return undefined;
    return {
      directory: typeof obj.directory === "string" ? obj.directory : "",
      payload: { id: payload.id as string | undefined, type: payload.type, properties: payload.properties },
    };
  }
  if (typeof obj.type === "string" && "properties" in obj && !("data" in obj)) {
    return { directory: "", payload: { id: obj.id as string | undefined, type: obj.type, properties: obj.properties } };
  }
  return undefined;
}

/** Parse a text/event-stream body into the `data` payload of each event. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (dataLines.length) {
            yield dataLines.join("\n");
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    if (dataLines.length) yield dataLines.join("\n");
  } finally {
    reader.releaseLock();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function parseModel(spec: string): ModelRef | undefined {
  const raw = spec.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

export function textOf(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}
