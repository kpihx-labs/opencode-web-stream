/**
 * Shapes of the OpenCode server events and REST payloads we rely on.
 *
 * These mirror `packages/schema/src/v1/*` of opencode v1.18.x. They are written
 * by hand rather than imported so the daemon has no dependency on the OpenCode
 * source tree, and so a field we never read cannot break the build.
 */

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type ToolState = {
  status: ToolStatus;
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
};

export type PartBase = {
  id: string;
  sessionID: string;
  messageID: string;
};

export type TextPart = PartBase & {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
};

export type ToolPart = PartBase & {
  type: "tool";
  tool: string;
  callID: string;
  state: ToolState;
};

export type ReasoningPart = PartBase & { type: "reasoning"; text: string };
export type StepPart = PartBase & { type: "step-start" | "step-finish" };
export type OtherPart = PartBase & { type: string; [k: string]: unknown };

export type Part = TextPart | ToolPart | ReasoningPart | StepPart | OtherPart;

export type MessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  agent?: string;
  time: { created: number; completed?: number };
  error?: { name?: string; data?: unknown };
  /** Assistant messages of a compaction turn carry this. */
  summary?: boolean;
};

export type SessionInfo = {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  agent?: string;
  version: string;
  time: { created: number; updated: number };
};

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message?: string; next?: number };

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};

export type QuestionOption = { label: string; description: string };
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

export type TodoItem = { id: string; content: string; status: string };

/**
 * The subset of the bus we act on. `properties` is typed per event; anything
 * else arrives as `{ type: string; properties: unknown }` and is ignored.
 */
export type OpencodeEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  | { type: "server.instance.disposed"; properties: Record<string, unknown> }
  | { type: "session.created"; properties: { info: SessionInfo } }
  | { type: "session.updated"; properties: { info: SessionInfo } }
  | { type: "session.deleted"; properties: { info: SessionInfo } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatus } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.error"; properties: { sessionID?: string; error?: { name?: string; data?: unknown } } }
  | { type: "session.compacted"; properties: { sessionID: string } }
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { part: Part; delta?: string } }
  | {
      type: "message.part.delta";
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "permission.updated"; properties: PermissionRequest }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: string } }
  | { type: "question.asked"; properties: QuestionRequest }
  | { type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  | { type: "todo.updated"; properties: { sessionID: string; todos: TodoItem[] } }
  | { type: "file.edited"; properties: { file: string } }
  | { type: "vcs.branch.updated"; properties: { branch?: string } }
  | { type: string; properties: unknown };

/** `/global/event` wraps every payload with the directory it came from. */
export type GlobalEnvelope = { directory: string; payload: { id?: string; type: string; properties: unknown } };

export type PermissionReply = "once" | "always" | "reject";

export type ModelRef = { providerID: string; modelID: string };

export type PromptBody = {
  messageID?: string;
  agent?: string;
  model?: ModelRef;
  noReply?: boolean;
  system?: string;
  parts: Array<{ type: "text"; text: string }>;
};

export function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

export function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}
