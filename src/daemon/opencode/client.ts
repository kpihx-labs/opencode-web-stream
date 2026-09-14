import type {
  GlobalEnvelope,
  MessageInfo,
  ModelRef,
  Part,
  PermissionReply,
  PromptBody,
  SessionInfo,
  SessionStatus,
} from "../../shared/opencode-events.js";
import type { ScopedLogger } from "../log.js";

/**
 * Minimal, dependency-free client for the OpenCode HTTP server (v1 routes).
 *
 * Only the routes the daemon needs are implemented, each against the path
 * verified in `packages/opencode/src/server/routes/instance/httpapi/groups/*`.
 * Every call carries the session's directory in `x-opencode-directory` so a
 * multi-project server routes it to the right instance.
 */

export type WithParts = { info: MessageInfo; parts: Part[] };
export type Project = { id: string; worktree: string; name?: string };

export type FetchLike = typeof fetch;

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

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.log = opts.log;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15000;
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
    const timer = setTimeout(() => controller.abort(new Error("timeout")), opts.timeoutMs ?? this.defaultTimeoutMs);
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
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // ---- sessions -----------------------------------------------------------

  createSession(directory: string, body: { title?: string; parentID?: string } = {}): Promise<SessionInfo> {
    return this.request<SessionInfo>("POST", "/session", { directory, body });
  }

  getSession(sessionID: string, directory: string): Promise<SessionInfo> {
    return this.request<SessionInfo>("GET", `/session/${encodeURIComponent(sessionID)}`, { directory });
  }

  listSessions(directory: string): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>("GET", "/session", { directory });
  }

  listProjects(): Promise<Project[]> {
    return this.request<Project[]>("GET", "/project");
  }

  messages(sessionID: string, directory: string, limit = 20): Promise<WithParts[]> {
    return this.request<WithParts[]>("GET", `/session/${encodeURIComponent(sessionID)}/message`, {
      directory,
      query: { limit },
    });
  }

  sessionStatus(directory: string): Promise<Record<string, SessionStatus>> {
    return this.request<Record<string, SessionStatus>>("GET", "/session/status", { directory });
  }

  /** Synchronous prompt: resolves with the assistant message once the turn ends. */
  prompt(sessionID: string, directory: string, body: PromptBody, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WithParts> {
    return this.request<WithParts>("POST", `/session/${encodeURIComponent(sessionID)}/message`, {
      directory,
      body,
      timeoutMs: opts.timeoutMs ?? 120000,
      signal: opts.signal,
    });
  }

  /** Queue a prompt and return immediately (204). Queues behind a running turn. */
  async promptAsync(sessionID: string, directory: string, body: PromptBody): Promise<void> {
    await this.request<void>("POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, { directory, body });
  }

  async abort(sessionID: string, directory: string): Promise<void> {
    await this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/abort`, { directory });
  }

  async summarize(sessionID: string, directory: string, model: ModelRef): Promise<void> {
    await this.request<boolean>("POST", `/session/${encodeURIComponent(sessionID)}/summarize`, {
      directory,
      body: { providerID: model.providerID, modelID: model.modelID },
      timeoutMs: 120000,
    });
  }

  // ---- permissions & questions -------------------------------------------

  async respondPermission(sessionID: string, directory: string, permissionID: string, response: PermissionReply): Promise<void> {
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

  async replyQuestion(directory: string, requestID: string, answers: string[][]): Promise<void> {
    await this.request<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reply`, {
      directory,
      body: { answers },
    });
  }

  async rejectQuestion(directory: string, requestID: string): Promise<void> {
    await this.request<boolean>("POST", `/question/${encodeURIComponent(requestID)}/reject`, { directory });
  }

  async health(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/global/health", { timeoutMs: 4000 });
      return true;
    } catch {
      return false;
    }
  }

  // ---- events -------------------------------------------------------------

  /**
   * Subscribe to `/global/event` with automatic reconnection. Resolves when
   * `signal` aborts. `onEvent` receives one envelope per bus event.
   */
  async subscribeGlobal(
    onEvent: (envelope: GlobalEnvelope) => void,
    hooks: { signal: AbortSignal; onOpen?: () => void; onClose?: (err?: Error) => void; idleTimeoutMs?: number },
  ): Promise<void> {
    let backoff = 500;
    const idleTimeoutMs = hooks.idleTimeoutMs ?? 40000;
    while (!hooks.signal.aborted) {
      const attempt = new AbortController();
      const stop = () => attempt.abort(new Error("stopped"));
      hooks.signal.addEventListener("abort", stop, { once: true });
      let idleTimer: NodeJS.Timeout | undefined;
      const bump = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => attempt.abort(new Error("sse idle")), idleTimeoutMs);
      };
      try {
        const res = await this.fetchImpl(this.baseUrl + "/global/event", {
          headers: this.headers(undefined, { accept: "text/event-stream" }),
          signal: attempt.signal,
        });
        if (!res.ok || !res.body) {
          throw new OpencodeHttpError(res.status, "GET", "/global/event", await res.text().catch(() => ""));
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
          const env = normalizeEnvelope(parsed);
          if (env) onEvent(env);
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
}

/** Accept both `{directory, payload}` envelopes and bare `{type, properties}` events. */
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
  if (typeof obj.type === "string") {
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
