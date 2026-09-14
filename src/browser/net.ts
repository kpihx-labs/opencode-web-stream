import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../shared/protocol.js";
import { log } from "./log.js";

/**
 * The cockpit's link to the daemon.
 *
 * Everything goes through the current origin so the Lens reverse proxy, a LAN
 * address and a Tailscale HTTPS name all work without configuration: the
 * websocket at `/ws/stream`, the HTTP endpoints under `/__stream__`.
 * Reconnection is exponential with jitter, and the socket is considered dead
 * as soon as a heartbeat is missed rather than waiting for TCP to notice.
 */

export type LinkHandlers = {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
};

const WS_PATH = "/ws/stream";
const API_BASE = "/__stream__";
const HEARTBEAT_MS = 20000;
const HEARTBEAT_GRACE_MS = 12000;

export class DaemonLink {
  private ws?: WebSocket;
  private reconnectTimer?: number;
  private heartbeatTimer?: number;
  private lastPongAt = 0;
  private attempt = 0;
  private closed = false;
  connected = false;

  constructor(private readonly handlers: LinkHandlers) {}

  static wsUrl(): string {
    const secure = location.protocol === "https:";
    return `${secure ? "wss:" : "ws:"}//${location.host}${WS_PATH}`;
  }

  static apiUrl(path: string): string {
    return `${API_BASE}${path}`;
  }

  open() {
    this.closed = false;
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.teardownSocket();
    let ws: WebSocket;
    try {
      ws = new WebSocket(DaemonLink.wsUrl());
    } catch (err) {
      log.warn("websocket construction failed", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.connected = true;
      this.lastPongAt = Date.now();
      this.startHeartbeat();
      log.info("link open");
      this.handlers.onOpen();
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "pong") {
        this.lastPongAt = Date.now();
        return;
      }
      if (msg.type === "reload") {
        log.warn("daemon asked for a reload", msg.reason);
        this.close();
        return;
      }
      try {
        this.handlers.onMessage(msg);
      } catch (err) {
        log.error("message handler threw", err);
      }
    };
    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      if (wasConnected) {
        log.info("link closed");
        this.handlers.onClose();
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // `onclose` always follows; nothing to do but keep the log quiet.
    };
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > HEARTBEAT_MS + HEARTBEAT_GRACE_MS) {
        log.warn("heartbeat missed, reconnecting");
        this.ws.close();
        return;
      }
      this.send({ type: "ping", t: Date.now() });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const base = Math.min(500 * 2 ** (this.attempt - 1), 15000);
    const delay = base * (0.7 + Math.random() * 0.6);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private teardownSocket() {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already gone
    }
    this.ws = undefined;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn("send failed", err);
      return false;
    }
  }

  attach(sessionID: string, directory: string | undefined, visible: boolean) {
    this.send({ type: "attach", sessionID, directory, protocol: PROTOCOL_VERSION, visible });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopHeartbeat();
    this.teardownSocket();
    this.connected = false;
  }
}

/** POST audio to the daemon's transcription proxy. */
export async function postAudio(
  blob: Blob,
  params: { sessionID: string; lang?: string; bargeIn?: boolean; spokenOver?: string; apply?: boolean },
  signal?: AbortSignal,
): Promise<{ text: string; decision?: string }> {
  const query = new URLSearchParams({ session: params.sessionID });
  if (params.lang) query.set("lang", params.lang);
  if (params.bargeIn) query.set("bargeIn", "1");
  if (params.spokenOver) query.set("spokenOver", params.spokenOver.slice(0, 500));
  if (params.apply === false) query.set("apply", "0");
  const res = await fetch(DaemonLink.apiUrl(`/api/stt?${query}`), {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
    signal,
  });
  if (!res.ok) throw new Error(`stt HTTP ${res.status}`);
  return (await res.json()) as { text: string; decision?: string };
}

/** Fetch synthesized audio for one utterance. */
export async function postTts(text: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(DaemonLink.apiUrl("/api/tts"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`tts HTTP ${res.status}`);
  return await res.blob();
}
