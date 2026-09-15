import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * A stand-in for `opencode serve`, speaking the real v1 routes and the real
 * `/global/event` SSE envelope shape.
 *
 * The point is to drive the daemon through situations that are painful to
 * reproduce against a live server: a streamer that answers a specific token, a
 * session that stays busy, a permission that is never answered, a stream that
 * drops mid-answer.
 */
export class FakeOpencode {
  constructor() {
    this.sessions = new Map();
    this.messages = new Map();
    this.prompts = [];
    this.aborts = [];
    this.permissionReplies = [];
    this.questionReplies = [];
    this.summarizes = [];
    /** sessionID -> reply text, or a function of the prompt body. */
    this.streamerReplies = new Map();
    /** Default reply when no per-session reply is registered. */
    this.defaultReply = "<quiet/>";
    this.clients = new Set();
    this.failNextPrompt = undefined;
    this.promptDelayMs = 0;
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this.url;
  }

  async close() {
    for (const res of this.clients) res.end();
    this.clients.clear();
    // Keep-alive sockets would hold `close` open for seconds otherwise.
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  // ---- fixtures ----------------------------------------------------------

  addSession(info) {
    const session = {
      id: info.id ?? `ses_${randomUUID().slice(0, 8)}`,
      title: info.title ?? "session",
      directory: info.directory ?? "/tmp/project",
      parentID: info.parentID,
      agent: info.agent ?? "build",
      version: "1.18.31",
      time: { created: Date.now(), updated: Date.now() },
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  addMessage(sessionID, message) {
    const list = this.messages.get(sessionID) ?? [];
    list.push(message);
    this.messages.set(sessionID, list);
  }

  /** Register what the streamer session should answer next. */
  replyWith(text) {
    this.defaultReply = text;
  }

  // ---- events ------------------------------------------------------------

  emit(directory, type, properties) {
    const payload = { id: `evt_${randomUUID().slice(0, 8)}`, type, properties };
    const line = `data: ${JSON.stringify({ directory, payload })}\n\n`;
    for (const res of this.clients) res.write(line);
  }

  /** Wait until at least one SSE client is attached. */
  async waitForSubscriber(timeoutMs = 4000) {
    const started = Date.now();
    while (this.clients.size === 0) {
      if (Date.now() - started > timeoutMs) throw new Error("no SSE subscriber");
      await new Promise((r) => setTimeout(r, 10));
    }
    // One extra tick so the subscriber's handler is installed.
    await new Promise((r) => setTimeout(r, 20));
  }

  /** Prompts sent to any session other than the ones we created as "main". */
  streamerPrompts(mainSessionIDs = []) {
    const mains = new Set(mainSessionIDs);
    return this.prompts.filter((p) => !mains.has(p.sessionID));
  }

  // ---- http --------------------------------------------------------------

  handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (path === "/global/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ payload: { id: "e0", type: "server.connected", properties: {} } })}\n\n`);
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }
    if (path === "/global/health") return json(res, 200, { status: "ok" });
    if (path === "/project") {
      const dirs = [...new Set([...this.sessions.values()].map((s) => s.directory))];
      return json(res, 200, dirs.map((d, i) => ({ id: `prj_${i}`, worktree: d })));
    }

    const collect = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : {};
    };

    // /session/:id/...
    const m = path.match(/^\/session\/([^/]+)(\/.*)?$/);
    if (m) {
      const sessionID = decodeURIComponent(m[1]);
      const rest = m[2] ?? "";
      const session = this.sessions.get(sessionID);
      if (!session && rest !== "" ) {
        if (!sessionID.startsWith("ses_")) return json(res, 404, { error: "not found" });
      }
      if (rest === "" && req.method === "GET") {
        if (!session) return json(res, 404, { error: "not found" });
        return json(res, 200, session);
      }
      if (rest === "/message" && req.method === "GET") {
        return json(res, 200, this.messages.get(sessionID) ?? []);
      }
      if (rest === "/message" && req.method === "POST") {
        return void collect().then((body) => this.onPrompt(res, sessionID, body, false));
      }
      if (rest === "/prompt_async" && req.method === "POST") {
        return void collect().then((body) => this.onPrompt(res, sessionID, body, true));
      }
      if (rest === "/abort" && req.method === "POST") {
        this.aborts.push(sessionID);
        return json(res, 200, true);
      }
      if (rest === "/summarize" && req.method === "POST") {
        this.summarizes.push(sessionID);
        return json(res, 200, true);
      }
      const perm = rest.match(/^\/permissions\/([^/]+)$/);
      if (perm && req.method === "POST") {
        return void collect().then((body) => {
          this.permissionReplies.push({ sessionID, permissionID: perm[1], response: body.response });
          json(res, 200, true);
        });
      }
    }

    if (path === "/session" && req.method === "POST") {
      return void collect().then((body) => {
        // The real server routes by `x-opencode-directory`, not by the body.
        const directory =
          req.headers["x-opencode-directory"] ??
          url.searchParams.get("directory") ??
          body.directory ??
          [...this.sessions.values()][0]?.directory ??
          "/tmp/project";
        const created = this.addSession({ title: body.title, directory });
        json(res, 200, created);
      });
    }
    if (path === "/session" && req.method === "GET") return json(res, 200, [...this.sessions.values()]);
    if (path === "/session/status" && req.method === "GET") return json(res, 200, {});

    const q = path.match(/^\/question\/([^/]+)\/(reply|reject)$/);
    if (q && req.method === "POST") {
      return void collect().then((body) => {
        this.questionReplies.push({ requestID: q[1], action: q[2], answers: body.answers });
        json(res, 200, true);
      });
    }

    json(res, 404, { error: `no route for ${req.method} ${path}` });
  }

  onPrompt(res, sessionID, body, async_) {
    const entry = { sessionID, body, at: Date.now(), async: async_ };
    this.prompts.push(entry);
    if (this.failNextPrompt) {
      const status = this.failNextPrompt;
      this.failNextPrompt = undefined;
      return json(res, status, { error: "injected failure" });
    }
    if (async_) {
      res.writeHead(204).end();
      return;
    }
    if (body.noReply) {
      return json(res, 200, { info: { id: `msg_${randomUUID().slice(0, 6)}`, sessionID, role: "user", time: { created: Date.now() } }, parts: [] });
    }
    const registered = this.streamerReplies.get(sessionID);
    const text = typeof registered === "function" ? registered(body) : (registered ?? this.defaultReply);
    const send = () =>
      json(res, 200, {
        info: { id: `msg_${randomUUID().slice(0, 6)}`, sessionID, role: "assistant", time: { created: Date.now(), completed: Date.now() } },
        parts: [{ id: `prt_${randomUUID().slice(0, 6)}`, sessionID, messageID: "m", type: "text", text }],
      });
    if (this.promptDelayMs) setTimeout(send, this.promptDelayMs);
    else send();
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Poll until `fn()` is truthy, or throw. Returns the value. */
export async function until(fn, { timeoutMs = 4000, intervalMs = 10, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
