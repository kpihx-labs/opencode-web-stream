import type { ToolPart } from "../../shared/opencode-events.js";

/**
 * A beat is a short window of tool activity handed to the streamer as one
 * event. Windows close on time, on size, or when the session changes phase
 * (starts answering, blocks, goes idle). The window never decides whether
 * the activity is interesting: that is the streamer's call.
 */

export type ToolRecord = {
  callID: string;
  tool: string;
  status: "completed" | "error" | "running";
  title: string;
  input: string;
  output: string;
  elapsedMs?: number;
  /** Set when the tool ran in a child session spawned by `task`. */
  via?: string;
};

export type Beat = {
  sessionID: string;
  tools: ToolRecord[];
  openedAt: number;
  closedAt: number;
  reason: "time" | "size" | "phase";
};

export type BeatWindowOptions = {
  windowMs: number;
  maxTools: number;
  inputChars: number;
  outputChars: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class BeatWindow {
  private tools: ToolRecord[] = [];
  private seen = new Set<string>();
  private openedAt = 0;
  private timer: unknown;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    readonly sessionID: string,
    private readonly opts: BeatWindowOptions,
    private readonly onFlush: (beat: Beat) => void,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get size(): number {
    return this.tools.length;
  }

  /** Record a finished tool call. Duplicate callIDs are ignored. */
  add(part: ToolPart, via?: string) {
    if (part.state.status !== "completed" && part.state.status !== "error") return;
    const key = part.callID || part.id;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.tools.push(toRecord(part, this.opts, via));
    if (this.tools.length === 1) {
      this.openedAt = this.now();
      this.timer = this.setTimer(() => this.flush("time"), this.opts.windowMs);
    }
    if (this.tools.length >= this.opts.maxTools) this.flush("size");
  }

  /** Close the window now (phase change) if it holds anything. */
  flush(reason: Beat["reason"] = "phase"): Beat | undefined {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.tools.length === 0) return undefined;
    const beat: Beat = {
      sessionID: this.sessionID,
      tools: this.tools,
      openedAt: this.openedAt,
      closedAt: this.now(),
      reason,
    };
    this.tools = [];
    // Keep recent callIDs so a late duplicate update cannot re-add a tool.
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
    this.onFlush(beat);
    return beat;
  }

  dispose() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.tools = [];
  }
}

export function toRecord(part: ToolPart, opts: { inputChars: number; outputChars: number }, via?: string): ToolRecord {
  const st = part.state;
  const status = st.status === "error" ? "error" : st.status === "completed" ? "completed" : "running";
  const output = status === "error" ? st.error ?? st.output ?? "" : st.output ?? "";
  const elapsedMs = st.time?.start && st.time?.end ? st.time.end - st.time.start : undefined;
  return {
    callID: part.callID || part.id,
    tool: part.tool,
    status,
    title: (st.title ?? "").slice(0, 160),
    input: condenseInput(part.tool, st.input ?? {}, opts.inputChars),
    output: excerpt(output, opts.outputChars),
    elapsedMs,
    via,
  };
}

/** Keep the arguments a narrator needs and nothing more. */
export function condenseInput(tool: string, input: Record<string, unknown>, max: number): string {
  const pick = (...keys: string[]) =>
    keys
      .map((k) => [k, input[k]] as const)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  let s: string;
  switch (tool) {
    case "read":
      s = pick("filePath", "offset", "limit");
      break;
    case "edit":
    case "write":
    case "apply_patch":
      s = pick("filePath", "path");
      break;
    case "bash":
    case "shell":
      s = pick("command", "description");
      break;
    case "glob":
    case "grep":
      s = pick("pattern", "path", "include");
      break;
    case "webfetch":
    case "websearch":
      s = pick("url", "query");
      break;
    case "task":
      s = pick("description", "subagent_type", "prompt");
      break;
    case "todowrite":
      s = Array.isArray(input.todos) ? `${input.todos.length} todos` : "";
      break;
    case "question":
      s = pick("questions");
      break;
    default:
      s = JSON.stringify(input);
  }
  if (!s) s = JSON.stringify(input);
  return excerpt(s, max);
}

export function excerpt(text: string, max: number): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

/** Render a beat for the streamer prompt. */
export function renderBeat(beat: Beat, context: { userPrompt: string; sessionTitle: string; todo?: string; elapsedSinceStartMs?: number }): string {
  const lines: string[] = [];
  lines.push("[BEAT]");
  lines.push(`session: ${context.sessionTitle || beat.sessionID}`);
  if (context.elapsedSinceStartMs !== undefined) lines.push(`elapsed: ${Math.round(context.elapsedSinceStartMs / 1000)}s since the prompt`);
  if (context.userPrompt) lines.push(`prompt: ${excerpt(context.userPrompt, 400)}`);
  if (context.todo) lines.push(`plan: ${excerpt(context.todo, 300)}`);
  lines.push(`tools (${beat.tools.length}, window closed on ${beat.reason}):`);
  for (const t of beat.tools) {
    const via = t.via ? ` via ${t.via}` : "";
    const err = t.status === "error" ? " FAILED" : "";
    lines.push(`- ${t.tool}${via}${err}: ${t.title || t.input}`);
    if (t.input && t.input !== t.title) lines.push(`  args: ${t.input}`);
    if (t.output) lines.push(`  out: ${t.output}`);
  }
  return lines.join("\n");
}
