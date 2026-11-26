import type { SessionStatus, ToolPart } from "../../shared/opencode-events.js";
import { condenseInput, excerpt } from "./beats.js";

/**
 * Authoritative live execution ledger for a root session and all of its
 * spawned subagent sessions. Keeps the streamer synchronized at every
 * millisecond with what the main agent is actually running right now, what
 * subagents are active, which tools just completed, and what intermediate
 * messages appeared in the main chat.
 */

export type RunningTool = {
  callID: string;
  tool: string;
  sessionID: string;
  via?: string;
  input: string;
  startedAt: number;
};

export type CompletedTool = {
  callID: string;
  tool: string;
  via?: string;
  status: "completed" | "error";
  input: string;
  output: string;
  finishedAt: number;
  elapsedMs?: number;
};

export type SubagentInfo = {
  id: string;
  agent?: string;
  title?: string;
  status: SessionStatus["type"];
  startedAt: number;
  updatedAt: number;
  lastText?: string;
};

export type ChatNote = {
  text: string;
  at: number;
};

export class ExecutionLedger {
  status: SessionStatus["type"] = "idle";
  busySince = 0;
  lastActivityAt = 0;
  lastSpokenAt = 0;
  activeTask = "";
  pendingInject?: { text: string; mode: "queue" | "interrupt"; at: number };
  readonly runningTools = new Map<string, RunningTool>();
  readonly subagents = new Map<string, SubagentInfo>();
  readonly recentTools: CompletedTool[] = [];
  readonly chatNotes: ChatNote[] = [];

  setTask(task: string, now = Date.now()) {
    const clean = task.trim();
    if (!clean) return;
    if (clean !== this.activeTask) {
      this.activeTask = clean;
      this.chatNotes.length = 0;
    }
    this.lastActivityAt = now;
  }

  setPendingInject(inject: { text: string; mode: "queue" | "interrupt"; at: number } | undefined) {
    this.pendingInject = inject;
  }

  onStatus(sessionID: string, isRoot: boolean, status: SessionStatus, now = Date.now()) {
    this.lastActivityAt = now;
    if (isRoot) {
      const prev = this.status;
      this.status = status.type;
      if (status.type === "busy" || status.type === "retry") {
        if (prev === "idle" || !this.busySince) this.busySince = now;
      } else {
        this.busySince = 0;
        for (const [k, t] of this.runningTools) {
          if (t.sessionID === sessionID) this.runningTools.delete(k);
        }
      }
      return;
    }
    const existing = this.subagents.get(sessionID);
    if (existing) {
      existing.status = status.type;
      existing.updatedAt = now;
      if (status.type === "idle") {
        for (const [k, t] of this.runningTools) {
          if (t.sessionID === sessionID) this.runningTools.delete(k);
        }
      }
    } else if (status.type !== "idle") {
      this.subagents.set(sessionID, {
        id: sessionID,
        status: status.type,
        startedAt: now,
        updatedAt: now,
      });
    }
  }

  onSubagentInfo(id: string, info: { agent?: string; title?: string; status?: SessionStatus["type"] }, now = Date.now()) {
    this.lastActivityAt = now;
    const existing = this.subagents.get(id);
    if (existing) {
      if (info.agent) existing.agent = info.agent;
      if (info.title) existing.title = info.title;
      if (info.status) existing.status = info.status;
      existing.updatedAt = now;
    } else {
      this.subagents.set(id, {
        id,
        agent: info.agent,
        title: info.title,
        status: info.status ?? "busy",
        startedAt: now,
        updatedAt: now,
      });
    }
    if (this.subagents.size > 20) {
      for (const [k, v] of this.subagents) {
        if (v.status === "idle") {
          this.subagents.delete(k);
          break;
        }
      }
    }
  }

  onSubagentText(id: string, text: string, now = Date.now()) {
    const clean = text.trim();
    if (!clean) return;
    this.lastActivityAt = now;
    const existing = this.subagents.get(id);
    if (existing) {
      existing.lastText = clean;
      existing.updatedAt = now;
    }
  }

  onSubagentRemoved(id: string) {
    this.subagents.delete(id);
    for (const [k, t] of this.runningTools) {
      if (t.sessionID === id) this.runningTools.delete(k);
    }
  }

  onTool(part: ToolPart, sessionID: string, via: string | undefined, now = Date.now()) {
    this.lastActivityAt = now;
    const key = part.callID || part.id;
    const st = part.state;
    if (st.status === "running" || st.status === "pending") {
      const existing = this.runningTools.get(key);
      const input = condenseInput(part.tool, st.input ?? {}, 180);
      this.runningTools.set(key, {
        callID: key,
        tool: part.tool,
        sessionID,
        via: via ?? existing?.via,
        input: input && input !== "{}" ? input : existing?.input ?? "",
        startedAt: existing?.startedAt ?? st.time?.start ?? now,
      });
      return;
    }
    this.runningTools.delete(key);
    const rawOut = st.status === "error" ? st.error ?? st.output ?? "" : st.output ?? "";
    const input = condenseInput(part.tool, st.input ?? {}, 180);
    const existingIdx = this.recentTools.findIndex((t) => t.callID === key);
    const rec: CompletedTool = {
      callID: key,
      tool: part.tool,
      via,
      status: st.status === "error" ? "error" : "completed",
      input,
      output: excerpt(rawOut, 400),
      finishedAt: now,
      elapsedMs: st.time?.start && st.time?.end ? st.time.end - st.time.start : undefined,
    };
    if (existingIdx >= 0) {
      this.recentTools[existingIdx] = rec;
    } else {
      this.recentTools.push(rec);
      while (this.recentTools.length > 8) this.recentTools.shift();
    }
  }

  onChatNote(text: string, now = Date.now()): boolean {
    const clean = text.trim();
    if (!clean) return false;
    this.lastActivityAt = now;
    const last = this.chatNotes[this.chatNotes.length - 1];
    if (last && last.text === clean) return false;
    this.chatNotes.push({ text: clean, at: now });
    while (this.chatNotes.length > 4) this.chatNotes.shift();
    return true;
  }

  markSpoken(now = Date.now()) {
    this.lastSpokenAt = now;
  }

  hasActiveWork(): boolean {
    if (this.status !== "idle") return true;
    if (this.runningTools.size > 0) return true;
    for (const sub of this.subagents.values()) {
      if (sub.status !== "idle") return true;
    }
    return false;
  }

  renderLiveState(opts: {
    screenText?: string;
    todo?: string;
    pendingSummary?: string;
    now?: number;
    screenLimit?: number;
  } = {}): string {
    const now = opts.now ?? Date.now();
    const lines: string[] = ["[LIVE STATE]"];
    if (this.status === "idle" && !this.hasActiveWork()) {
      lines.push("session_status: idle");
    } else {
      const elapsed = this.busySince ? Math.max(0, Math.round((now - this.busySince) / 1000)) : 0;
      lines.push(`session_status: ${this.status} (active ${elapsed}s)`);
    }
    if (this.activeTask) lines.push(`active_task: ${excerpt(this.activeTask, 300)}`);
    if (this.pendingInject) {
      lines.push(`queued_inject (${this.pendingInject.mode}): ${excerpt(this.pendingInject.text, 220)}`);
    }
    if (opts.pendingSummary) lines.push(`blocked_waiting_user: ${excerpt(opts.pendingSummary, 260)}`);
    if (opts.todo) lines.push(`plan: ${excerpt(opts.todo, 300)}`);

    const running = [...this.runningTools.values()];
    if (running.length) {
      lines.push(`running_tools_now (${running.length}):`);
      for (const t of running.slice(-6)) {
        const sec = Math.max(0, Math.round((now - t.startedAt) / 1000));
        const via = t.via ? ` via ${t.via}` : "";
        lines.push(`- ${t.tool}${via} (${sec}s): ${t.input || "(running)"}`);
      }
    }

    const busySubs = [...this.subagents.values()].filter((s) => s.status !== "idle");
    if (busySubs.length) {
      lines.push(`active_subagents (${busySubs.length}):`);
      for (const sub of busySubs.slice(-5)) {
        const sec = Math.max(0, Math.round((now - sub.startedAt) / 1000));
        const label = sub.agent || "subagent";
        const title = sub.title ? ` "${excerpt(sub.title, 60)}"` : "";
        const note = sub.lastText ? ` | note: ${excerpt(sub.lastText, 120)}` : "";
        lines.push(`- ${label}${title} (${sub.status}, ${sec}s)${note}`);
      }
    }

    if (this.recentTools.length) {
      const tail = this.recentTools.slice(-4);
      lines.push(`recent_completed_tools (${tail.length}):`);
      for (const t of tail) {
        const age = Math.max(0, Math.round((now - t.finishedAt) / 1000));
        const via = t.via ? ` via ${t.via}` : "";
        const err = t.status === "error" ? " FAILED" : "";
        const out = t.output ? ` -> ${excerpt(t.output, 220)}` : " -> (empty output)";
        lines.push(`- [${age}s ago] ${t.tool}${via}${err}: ${t.input || "(no args)"}${out}`);
      }
    }

    if (this.chatNotes.length) {
      const notes = this.chatNotes.slice(-2);
      lines.push(`recent_chat_notes (${notes.length}):`);
      for (const n of notes) {
        const age = Math.max(0, Math.round((now - n.at) / 1000));
        lines.push(`- [${age}s ago] ${excerpt(n.text, 280)}`);
      }
    }

    const screen = (opts.screenText ?? "").trim();
    if (screen) {
      lines.push(`latest_screen_text:\n${screen.slice(0, opts.screenLimit ?? 1400)}`);
    }
    return lines.join("\n");
  }
}
