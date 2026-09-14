import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type DaemonStatus, type ServerMessage, type Utterance } from "../../shared/protocol.js";
import type { Config } from "../config.js";
import type { Logger, ScopedLogger } from "../log.js";
import type { Orchestrator, Outbound } from "../core/orchestrator.js";
import type { SttEngine } from "../engines/stt.js";
import type { TtsEngine } from "../engines/tts.js";

/**
 * HTTP + WebSocket front door for the browser cockpit (through the Lens
 * reverse proxy) and for any local tool that wants to inject a transcript.
 * Also elects, per session, the one cockpit that speaks.
 */

type Client = {
  id: string;
  ws: WebSocket;
  sessionID?: string;
  directory?: string;
  visible: boolean;
  attachedAt: number;
  alive: boolean;
};

export type HubDeps = {
  cfg: Config;
  logger: Logger;
  tts: TtsEngine;
  stt: SttEngine;
  version: string;
};

export class Hub implements Outbound {
  readonly server: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Client>();
  private readonly log: ScopedLogger;
  private orchestrator!: Orchestrator;
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly deps: HubDeps) {
    this.log = deps.logger.scope("hub");
    this.server = createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws/stream" && url.pathname !== "/__stream__/ws/stream") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, url));
    });
  }

  attach(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  listen(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.deps.cfg.port, this.deps.cfg.host, () => {
        const addr = this.server.address();
        const port = typeof addr === "object" && addr ? addr.port : this.deps.cfg.port;
        this.heartbeat = setInterval(() => this.pingAll(), 25000);
        this.heartbeat.unref?.();
        resolve({ port });
      });
    });
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients.values()) c.ws.close(1001, "daemon shutting down");
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- Outbound -----------------------------------------------------------

  toSession(sessionID: string, msg: ServerMessage) {
    for (const c of this.clients.values()) if (c.sessionID === sessionID) this.send(c, msg);
  }

  speak(utterance: Utterance) {
    const speaker = this.speakerFor(utterance.sessionID);
    if (speaker) {
      this.send(speaker, { type: "speak", utterance });
      return;
    }
    // Nobody is looking at this session: urgent items go to a cockpit in the same directory.
    if (utterance.kind !== "blocked") return;
    const s = this.orchestrator.sessions.get(utterance.sessionID);
    const fallback = [...this.clients.values()]
      .filter((c) => c.sessionID && c.sessionID !== utterance.sessionID && (!s?.directory || c.directory === s.directory || this.orchestrator.sessions.get(c.sessionID)?.directory === s?.directory))
      .sort((a, b) => Number(b.visible) - Number(a.visible) || b.attachedAt - a.attachedAt)[0];
    if (fallback) {
      const label = s?.title ? s.title : utterance.sessionID;
      this.send(fallback, { type: "speak", utterance: { ...utterance, sessionLabel: label, text: `Dans la session ${label} : ${utterance.text}` } });
    }
  }

  liveSessionsIn(directory: string): string[] {
    const out = new Set<string>();
    for (const c of this.clients.values()) {
      if (!c.sessionID) continue;
      const s = this.orchestrator.sessions.get(c.sessionID);
      if (s?.directory === directory && s.live) out.add(c.sessionID);
    }
    return [...out];
  }

  private speakerFor(sessionID: string): Client | undefined {
    return [...this.clients.values()]
      .filter((c) => c.sessionID === sessionID && c.ws.readyState === WebSocket.OPEN)
      .sort((a, b) => Number(b.visible) - Number(a.visible) || b.attachedAt - a.attachedAt)[0];
  }

  // ---- websocket ----------------------------------------------------------

  private onConnection(ws: WebSocket, url: URL) {
    const client: Client = { id: randomUUID(), ws, visible: true, attachedAt: Date.now(), alive: true };
    this.clients.set(client.id, client);
    const sessionFromUrl = url.searchParams.get("session") ?? undefined;
    if (sessionFromUrl) client.sessionID = sessionFromUrl;
    this.log.info("cockpit connected", { id: client.id, session: sessionFromUrl, clients: this.clients.size });
    void this.status().then((status) => this.send(client, { type: "hello", status, speakerToken: client.id }));
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data) => void this.onMessage(client, data.toString()));
    ws.on("close", () => {
      this.clients.delete(client.id);
      this.log.info("cockpit disconnected", { id: client.id, clients: this.clients.size });
    });
    ws.on("error", (err) => this.log.warn("cockpit socket error", { id: client.id, error: err.message }));
  }

  private pingAll() {
    for (const c of this.clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        this.clients.delete(c.id);
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        // closed underneath us
      }
    }
  }

  private async onMessage(client: Client, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(client, { type: "error", message: "invalid json" });
      return;
    }
    try {
      switch (msg.type) {
        case "attach": {
          if (msg.protocol !== PROTOCOL_VERSION) {
            this.send(client, { type: "reload", reason: `protocol ${msg.protocol} != ${PROTOCOL_VERSION}` });
            return;
          }
          client.sessionID = msg.sessionID;
          client.directory = msg.directory;
          client.visible = msg.visible;
          client.attachedAt = Date.now();
          const snap = this.orchestrator.snapshot(msg.sessionID);
          if (snap) {
            this.send(client, { type: "state", sessionID: msg.sessionID, state: snap.state, blocked: snap.blocked });
            this.send(client, { type: "lexicon", sessionID: msg.sessionID, phrases: this.orchestrator.phrasesFor(msg.sessionID) });
          }
          return;
        }
        case "detach":
          if (client.sessionID === msg.sessionID) client.sessionID = undefined;
          return;
        case "live": {
          client.sessionID = msg.sessionID;
          const snap = await this.orchestrator.setLive(msg.sessionID, msg.enabled, client.directory);
          if (!snap) this.send(client, { type: "error", message: "session introuvable côté OpenCode" });
          else this.send(client, { type: "state", sessionID: msg.sessionID, state: snap.state, blocked: snap.blocked });
          this.broadcastStatus();
          return;
        }
        case "transcript":
          await this.orchestrator.onTranscript(msg.sessionID, msg.text, { bargeIn: msg.bargeIn, spokenOver: msg.spokenOver, lang: msg.lang });
          return;
        case "barge_in":
          this.orchestrator.onBargeIn(msg.sessionID);
          return;
        case "barge_in_false":
          this.orchestrator.onBargeInFalse(msg.sessionID);
          return;
        case "spoken":
          this.orchestrator.onSpoken(msg.sessionID, msg.utteranceId, msg.completed, msg.heardText);
          return;
        case "prefs":
          this.orchestrator.setPrefs(msg.sessionID, { digest: msg.digest, muted: msg.muted });
          return;
        case "control": {
          const s = this.orchestrator.sessions.get(msg.sessionID);
          if (s) this.orchestrator.applyControl(s, msg.action);
          return;
        }
        case "visible":
          client.visible = msg.visible;
          return;
        case "cancel_inject":
          this.orchestrator.cancelInject(msg.sessionID, msg.injectId);
          return;
        case "ping":
          this.send(client, { type: "pong", t: msg.t });
          return;
        default:
          this.send(client, { type: "error", message: `unknown message type` });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error("message handling failed", { type: msg.type, error: message });
      this.send(client, { type: "error", message });
    }
  }

  private send(client: Client, msg: ServerMessage) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log.warn("send failed", { id: client.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private broadcastStatus() {
    void this.status().then((status) => {
      for (const c of this.clients.values()) this.send(c, { type: "status", status });
    });
  }

  async status(): Promise<DaemonStatus> {
    await Promise.all([this.deps.tts.check(), this.deps.stt.check()]);
    return {
      protocol: PROTOCOL_VERSION,
      opencode: this.orchestrator.connection,
      tts: this.deps.tts.describe(),
      stt: this.deps.stt.describe(),
      sessions: this.orchestrator.snapshots(),
    };
  }

  // ---- http ---------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = url.pathname;
    if (path.startsWith("/__stream__")) path = path.slice("/__stream__".length) || "/";
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, x-session, x-lang, x-mime");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { status: "ok", service: "opencode-web-stream", version: this.deps.version, protocol: PROTOCOL_VERSION, opencode: this.orchestrator.connection.connected, clients: this.clients.size });
        return;
      }
      if (req.method === "GET" && path === "/api/status") {
        json(res, 200, await this.status());
        return;
      }
      if (req.method === "GET" && path === "/api/logs") {
        json(res, 200, this.deps.logger.recent(Number(url.searchParams.get("limit") ?? 100)));
        return;
      }
      if (req.method === "GET" && path === "/api/sessions") {
        json(res, 200, this.orchestrator.snapshots());
        return;
      }
      if (req.method === "GET" && path === "/api/lexicon") {
        const sessionID = url.searchParams.get("session") ?? "";
        json(res, 200, { phrases: this.orchestrator.phrasesFor(sessionID) });
        return;
      }
      if (req.method === "POST" && path === "/api/live") {
        const body = (await readJson(req)) as { sessionID: string; enabled: boolean; directory?: string };
        const snap = await this.orchestrator.setLive(body.sessionID, Boolean(body.enabled), body.directory);
        json(res, snap ? 200 : 404, snap ?? { error: "session not found" });
        return;
      }
      if (req.method === "POST" && path === "/api/transcript") {
        const body = (await readJson(req)) as { sessionID: string; text: string; bargeIn?: boolean; lang?: string };
        const decision = await this.orchestrator.onTranscript(body.sessionID, body.text, { bargeIn: Boolean(body.bargeIn), lang: body.lang });
        json(res, 200, { decision });
        return;
      }
      if (req.method === "POST" && path === "/api/tts") {
        const body = (await readJson(req)) as { text: string; voice?: string; speed?: number };
        if (!body.text?.trim()) {
          json(res, 400, { error: "text required" });
          return;
        }
        try {
          const out = await this.deps.tts.synthesize(body.text, { voice: body.voice, speed: body.speed });
          res.writeHead(200, { "content-type": out.contentType, "content-length": out.bytes.length, "cache-control": "no-store" });
          res.end(out.bytes);
        } catch (e) {
          json(res, 502, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (req.method === "POST" && path === "/api/stt") {
        const sessionID = url.searchParams.get("session") ?? String(req.headers["x-session"] ?? "");
        const lang = url.searchParams.get("lang") ?? String(req.headers["x-lang"] ?? "");
        const apply = url.searchParams.get("apply") !== "0";
        const bargeIn = url.searchParams.get("bargeIn") === "1";
        const spokenOver = url.searchParams.get("spokenOver") ?? undefined;
        const mime = String(req.headers["content-type"] ?? "audio/wav").split(";")[0];
        const audio = await readBody(req, 25 * 1024 * 1024);
        if (audio.length < 1000) {
          json(res, 400, { error: "audio too short" });
          return;
        }
        try {
          const text = await this.deps.stt.transcribe(audio, {
            mime,
            language: lang || undefined,
            promptTerms: this.orchestrator.phrasesFor(sessionID),
          });
          let decision: string | undefined;
          if (apply && text && sessionID) {
            decision = await this.orchestrator.onTranscript(sessionID, text, { bargeIn, spokenOver, lang: lang || undefined });
          }
          json(res, 200, { text, decision });
        } catch (e) {
          json(res, 502, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      this.log.error("http handler failed", { path, error: e instanceof Error ? e.message : String(e) });
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}
