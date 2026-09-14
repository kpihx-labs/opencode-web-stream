import { randomUUID } from "node:crypto";
import type {
  GlobalEnvelope,
  MessageInfo,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionInfo,
  SessionStatus,
  ToolPart,
} from "../../shared/opencode-events.js";
import { isTextPart, isToolPart } from "../../shared/opencode-events.js";
import type { ControlAction, LiveState, ServerMessage, SessionSnapshot, SpeechKind, Utterance } from "../../shared/protocol.js";
import type { Config } from "../config.js";
import type { Logger, ScopedLogger } from "../log.js";
import { buildLexicon, type Lexicon } from "../lexicon/build.js";
import { candidatesFor, renderLexiconContext, topPhrases } from "../lexicon/match.js";
import { OpencodeClient } from "../opencode/client.js";
import { BeatWindow, excerpt, renderBeat, type Beat } from "./beats.js";
import type { Registry } from "./registry.js";
import { codeRatio, SentenceSplitter } from "./sentences.js";
import { StreamerSession } from "./streamer.js";
import { IncrementalSpeechReader, parseStreamerOutput, type Decision } from "./tokens.js";

/**
 * The brain. Consumes the OpenCode event bus, keeps one state machine per
 * session, asks the streamer for decisions, and emits speech and state to the
 * cockpits through the `Outbound` port. All timing policy (windows, TTLs,
 * delays) lives here; all judgement lives in the streamer.
 */

export type Outbound = {
  /** Send to every cockpit attached to the session. */
  toSession(sessionID: string, msg: ServerMessage): void;
  /** Send to the cockpit currently elected speaker for the session (or a fallback in the directory). */
  speak(utterance: Utterance): void;
  /** Sessions in the same directory that have a live cockpit, for cross-session notices. */
  liveSessionsIn(directory: string): string[];
};

type AnswerStream = {
  messageID: string;
  streamId: string;
  seq: number;
  splitter: SentenceSplitter;
  fed: Map<string, number>;
  fullText: string;
  startedAt: number;
  spokenSentences: number;
  suppressed: boolean;
};

type Pending =
  | { kind: "permission"; req: PermissionRequest; repeats: number; timer?: NodeJS.Timeout; askedAt: number }
  | { kind: "question"; req: QuestionRequest; repeats: number; timer?: NodeJS.Timeout; askedAt: number };

export type Session = {
  id: string;
  directory: string;
  title: string;
  parentID?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  status: SessionStatus["type"];
  phase: LiveState;
  live: boolean;
  userPrompt: string;
  userPromptAt: number;
  lastAnswer: string;
  todo?: string;
  beats: BeatWindow;
  answer?: AnswerStream;
  pending?: Pending;
  clarify?: { question: string; transcript: string; at: number };
  lastSpoken?: string;
  lastHeard?: { raw: string; corrected: string };
  prefs: { digest: boolean; muted: boolean };
  userMessages: Set<string>;
  partTypes: Map<string, string>;
  streamer?: StreamerSession;
  streamerID?: string;
  inflightSpeech?: { reader: IncrementalSpeechReader; splitter: SentenceSplitter; streamId: string; seq: number; kind: SpeechKind; spoke: boolean };
  pendingInject?: { id: string; text: string; mode: "queue" | "interrupt"; timer: NodeJS.Timeout };
  retryAnnounced: boolean;
  injectedTexts: string[];
  lastBeatAt: number;
};

export class Orchestrator {
  readonly sessions = new Map<string, Session>();
  private readonly streamerIDs = new Map<string, string>(); // streamerID -> main session id
  private readonly lexicons = new Map<string, Lexicon>();
  private readonly lexiconBuilding = new Map<string, Promise<Lexicon>>();
  private readonly lexiconRefresh = new Map<string, NodeJS.Timeout>();
  private readonly log: ScopedLogger;
  private opencodeConnected = false;
  private lastOpencodeError?: string;

  constructor(
    private readonly cfg: Config,
    private readonly client: OpencodeClient,
    private readonly registry: Registry,
    private readonly out: Outbound,
    logger: Logger,
  ) {
    this.log = logger.scope("orchestrator");
  }

  // ---- connection state ----------------------------------------------------

  setConnected(connected: boolean, error?: string) {
    this.opencodeConnected = connected;
    this.lastOpencodeError = error;
  }

  get connection() {
    return { connected: this.opencodeConnected, url: this.client.baseUrl, lastError: this.lastOpencodeError };
  }

  // ---- session bookkeeping -------------------------------------------------

  private ensureSession(id: string, directory: string): Session {
    let s = this.sessions.get(id);
    if (s) {
      if (directory && !s.directory) s.directory = directory;
      return s;
    }
    const prefs = this.registry.prefs(id);
    s = {
      id,
      directory,
      title: "",
      status: "idle",
      phase: "idle",
      live: false,
      userPrompt: "",
      userPromptAt: 0,
      lastAnswer: "",
      beats: new BeatWindow(
        id,
        {
          windowMs: this.cfg.beats.windowMs,
          maxTools: this.cfg.beats.maxTools,
          inputChars: this.cfg.beats.inputChars,
          outputChars: this.cfg.beats.outputChars,
        },
        (beat) => this.onBeat(beat),
      ),
      prefs: { digest: prefs.digest ?? this.cfg.answer.mode === "digest", muted: prefs.muted ?? false },
      userMessages: new Set(),
      partTypes: new Map(),
      retryAnnounced: false,
      injectedTexts: [],
      lastBeatAt: 0,
    };
    this.sessions.set(id, s);
    return s;
  }

  /** The top-most ancestor: child sessions (task subagents) feed their parent. */
  private root(s: Session): Session {
    let cur = s;
    let hops = 0;
    while (cur.parentID && hops++ < 8) {
      const parent = this.sessions.get(cur.parentID);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }

  private isStreamer(sessionID: string): boolean {
    return this.streamerIDs.has(sessionID);
  }

  snapshot(sessionID: string): SessionSnapshot | undefined {
    const s = this.sessions.get(sessionID);
    if (!s) return undefined;
    return {
      sessionID: s.id,
      title: s.title,
      directory: s.directory,
      state: s.phase,
      live: s.live,
      blocked: s.pending ? { kind: s.pending.kind, summary: this.pendingSummary(s.pending) } : undefined,
      lastSpoken: s.lastSpoken,
      lastHeard: s.lastHeard,
    };
  }

  snapshots(): SessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((s) => s.live && !this.isStreamer(s.id))
      .map((s) => this.snapshot(s.id)!)
      .filter(Boolean);
  }

  // ---- live toggling -------------------------------------------------------

  async setLive(sessionID: string, enabled: boolean, directoryHint?: string): Promise<SessionSnapshot | undefined> {
    let s = this.sessions.get(sessionID);
    if (!s) {
      const directory = directoryHint || (await this.resolveDirectory(sessionID));
      if (!directory) {
        this.log.warn("cannot resolve directory for session", { sessionID });
        return undefined;
      }
      s = this.ensureSession(sessionID, directory);
    }
    if (enabled === s.live) return this.snapshot(sessionID);
    s.live = enabled;
    if (enabled) {
      this.log.info("live on", { sessionID, directory: s.directory });
      await this.hydrate(s);
      this.setPhase(s, s.status === "busy" ? "thinking" : "listening");
      void this.startStreamer(s);
    } else {
      this.log.info("live off", { sessionID });
      s.beats.flush("phase");
      this.clearInject(s);
      s.streamer?.dropBeats();
      this.setPhase(s, "idle");
    }
    return this.snapshot(sessionID);
  }

  /** Fill title, agent, model, last prompt and answer from the server. */
  private async hydrate(s: Session) {
    try {
      const info = await this.client.getSession(s.id, s.directory);
      this.applySessionInfo(s, info);
    } catch (e) {
      this.log.warn("hydrate: session lookup failed", { sessionID: s.id, error: e instanceof Error ? e.message : String(e) });
    }
    try {
      const msgs = await this.client.messages(s.id, s.directory, 12);
      for (const m of msgs) {
        const text = m.parts
          .filter((p) => isTextPart(p) && !(p as { synthetic?: boolean }).synthetic)
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim();
        if (m.info.role === "user") {
          s.userMessages.add(m.info.id);
          if (text) {
            s.userPrompt = text;
            s.userPromptAt = m.info.time.created;
          }
        } else if (text) {
          s.lastAnswer = text;
        }
        for (const p of m.parts) s.partTypes.set(p.id, p.type);
      }
    } catch (e) {
      this.log.warn("hydrate: messages lookup failed", { sessionID: s.id, error: e instanceof Error ? e.message : String(e) });
    }
    try {
      const status = await this.client.sessionStatus(s.directory);
      const st = status[s.id];
      if (st) s.status = st.type;
    } catch {
      // status is optional
    }
  }

  private async resolveDirectory(sessionID: string): Promise<string | undefined> {
    const known = this.sessions.get(sessionID)?.directory;
    if (known) return known;
    const bound = this.registry.binding(sessionID)?.directory;
    if (bound) return bound;
    try {
      const projects = await this.client.listProjects();
      for (const p of projects) {
        try {
          const info = await this.client.getSession(sessionID, p.worktree);
          return info.directory || p.worktree;
        } catch {
          // not in this project
        }
      }
    } catch (e) {
      this.log.warn("project listing failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return undefined;
  }

  private async startStreamer(s: Session) {
    if (!s.streamer) {
      s.streamer = new StreamerSession(
        s.id,
        s.directory,
        s.title,
        this.client,
        this.registry,
        {
          agent: this.cfg.streamer.agent,
          model: this.cfg.streamer.model,
          summarizeEveryPrompts: this.cfg.streamer.summarizeEveryPrompts,
        },
        this.log,
        {
          onStreamerID: (id) => {
            if (s.streamerID && s.streamerID !== id) this.streamerIDs.delete(s.streamerID);
            s.streamerID = id;
            this.streamerIDs.set(id, s.id);
          },
        },
      );
    }
    try {
      const lexicon = await this.lexiconFor(s.directory);
      this.out.toSession(s.id, { type: "lexicon", sessionID: s.id, phrases: topPhrases(lexicon, this.registry.aliases(), this.cfg.lexicon.phraseTerms) });
      await s.streamer.seed(this.contextBlock(s, lexicon));
    } catch (e) {
      this.log.error("streamer start failed", { sessionID: s.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private contextBlock(s: Session, lexicon: Lexicon | undefined): string {
    const lines = ["[CONTEXT]", `date: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, `session: ${s.title || s.id}`, `directory: ${s.directory}`];
    if (s.agent) lines.push(`main agent: ${s.agent}`);
    lines.push(`session is ${s.status}`);
    if (s.userPrompt) lines.push(`latest prompt from KπX: ${excerpt(s.userPrompt, 600)}`);
    if (s.lastAnswer) lines.push(`latest answer (excerpt): ${excerpt(s.lastAnswer, 600)}`);
    lines.push(`answer reading mode: ${s.prefs.digest ? "digest" : "full"}`);
    lines.push(renderLexiconContext(lexicon, this.registry.aliases(), this.cfg.lexicon.contextTerms));
    return lines.join("\n");
  }

  // ---- lexicon -------------------------------------------------------------

  async lexiconFor(directory: string): Promise<Lexicon | undefined> {
    if (!directory) return undefined;
    const cached = this.lexicons.get(directory);
    if (cached) return cached;
    let building = this.lexiconBuilding.get(directory);
    if (!building) {
      building = buildLexicon(directory, { maxFiles: this.cfg.lexicon.maxFiles, maxTerms: this.cfg.lexicon.maxTerms })
        .then((lex) => {
          this.lexicons.set(directory, lex);
          this.log.info("lexicon built", { directory, terms: lex.terms.size, files: lex.fileCount });
          return lex;
        })
        .finally(() => this.lexiconBuilding.delete(directory));
      this.lexiconBuilding.set(directory, building);
    }
    try {
      return await building;
    } catch (e) {
      this.log.warn("lexicon build failed", { directory, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  scheduleLexiconRefresh(directory: string) {
    if (!directory || !this.lexicons.has(directory)) return;
    const existing = this.lexiconRefresh.get(directory);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.lexiconRefresh.delete(directory);
      this.lexicons.delete(directory);
      void this.lexiconFor(directory).then((lex) => {
        for (const s of this.sessions.values()) {
          if (s.live && s.directory === directory) {
            this.out.toSession(s.id, { type: "lexicon", sessionID: s.id, phrases: topPhrases(lex, this.registry.aliases(), this.cfg.lexicon.phraseTerms) });
          }
        }
      });
    }, this.cfg.lexicon.refreshDebounceMs);
    t.unref?.();
    this.lexiconRefresh.set(directory, t);
  }

  phrasesFor(sessionID: string): string[] {
    const s = this.sessions.get(sessionID);
    const lex = s ? this.lexicons.get(s.directory) : undefined;
    return topPhrases(lex, this.registry.aliases(), this.cfg.lexicon.phraseTerms);
  }

  // ---- event ingestion -----------------------------------------------------

  handle(envelope: GlobalEnvelope) {
    const { directory, payload } = envelope;
    const type = payload.type;
    const props = (payload.properties ?? {}) as Record<string, unknown>;
    if (this.cfg.opencode.directories.length && directory && !this.cfg.opencode.directories.includes(directory)) return;
    try {
      switch (type) {
        case "session.created":
        case "session.updated": {
          const info = props.info as SessionInfo | undefined;
          if (!info) return;
          if (this.isStreamer(info.id)) return;
          const s = this.ensureSession(info.id, info.directory || directory);
          this.applySessionInfo(s, info);
          return;
        }
        case "session.deleted": {
          const info = props.info as SessionInfo | undefined;
          if (info) this.dropSession(info.id);
          return;
        }
        case "session.status": {
          const sessionID = props.sessionID as string;
          const status = props.status as SessionStatus;
          if (this.isStreamer(sessionID)) return;
          const s = this.ensureSession(sessionID, directory);
          this.onStatus(s, status);
          return;
        }
        case "session.idle": {
          const sessionID = props.sessionID as string;
          if (this.isStreamer(sessionID)) return;
          const s = this.ensureSession(sessionID, directory);
          this.onStatus(s, { type: "idle" });
          return;
        }
        case "session.error": {
          const sessionID = props.sessionID as string | undefined;
          if (!sessionID || this.isStreamer(sessionID)) return;
          const s = this.ensureSession(sessionID, directory);
          this.onError(s, props.error as { name?: string; data?: unknown } | undefined);
          return;
        }
        case "session.compacted": {
          const sessionID = props.sessionID as string;
          if (this.isStreamer(sessionID)) return;
          const s = this.sessions.get(sessionID);
          if (s && this.root(s).live) {
            const r = this.root(s);
            this.enqueueSpeech(r, "system", this.cfg.answer.codeNotice ? "Je condense ma mémoire, je continue." : "", 0);
            void this.reseed(r);
          }
          return;
        }
        case "message.updated": {
          const info = props.info as MessageInfo | undefined;
          if (!info) return;
          if (this.isStreamer(info.sessionID)) return;
          const s = this.ensureSession(info.sessionID, directory);
          if (info.role === "user") {
            s.userMessages.add(info.id);
          } else if (info.time.completed && s.answer?.messageID === info.id) {
            this.finishAnswer(s);
          }
          return;
        }
        case "message.part.updated": {
          const part = props.part as Part | undefined;
          if (!part) return;
          if (this.isStreamer(part.sessionID)) {
            this.onStreamerPart(part);
            return;
          }
          const s = this.ensureSession(part.sessionID, directory);
          this.onPart(s, part);
          return;
        }
        case "message.part.delta": {
          const sessionID = props.sessionID as string;
          const delta = props.delta as string;
          const partID = props.partID as string;
          const messageID = props.messageID as string;
          if (props.field !== "text" || !delta) return;
          if (this.isStreamer(sessionID)) {
            this.onStreamerDelta(sessionID, delta);
            return;
          }
          const s = this.sessions.get(sessionID);
          if (!s) return;
          this.onTextDelta(s, messageID, partID, delta);
          return;
        }
        case "permission.asked":
        case "permission.updated": {
          const req = props as unknown as PermissionRequest;
          if (!req.sessionID || this.isStreamer(req.sessionID)) return;
          const s = this.ensureSession(req.sessionID, directory);
          this.onPermission(s, req);
          return;
        }
        case "permission.replied": {
          const sessionID = props.sessionID as string;
          const s = this.sessions.get(sessionID);
          if (s?.pending?.kind === "permission" && s.pending.req.id === props.requestID) this.clearPending(s);
          return;
        }
        case "question.asked": {
          const req = props as unknown as QuestionRequest;
          if (!req.sessionID || this.isStreamer(req.sessionID)) return;
          const s = this.ensureSession(req.sessionID, directory);
          this.onQuestion(s, req);
          return;
        }
        case "question.replied":
        case "question.rejected": {
          const sessionID = props.sessionID as string;
          const s = this.sessions.get(sessionID);
          if (s?.pending?.kind === "question" && s.pending.req.id === props.requestID) this.clearPending(s);
          return;
        }
        case "todo.updated": {
          const sessionID = props.sessionID as string;
          const s = this.sessions.get(sessionID);
          const todos = props.todos as Array<{ content: string; status: string }> | undefined;
          if (s && todos) {
            s.todo = todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "·"} ${t.content}`).join(" | ");
          }
          return;
        }
        case "file.edited":
        case "vcs.branch.updated": {
          if (directory) this.scheduleLexiconRefresh(directory);
          return;
        }
        default:
          return;
      }
    } catch (e) {
      this.log.error("event handling failed", { type, error: e instanceof Error ? e.stack ?? e.message : String(e) });
    }
  }

  private applySessionInfo(s: Session, info: SessionInfo & { model?: { providerID: string; id?: string; modelID?: string } }) {
    s.title = info.title || s.title;
    s.parentID = info.parentID;
    s.agent = info.agent ?? s.agent;
    if (info.model?.providerID) s.model = { providerID: info.model.providerID, modelID: info.model.modelID ?? info.model.id ?? "" };
    if (!s.directory && info.directory) s.directory = info.directory;
    s.streamer?.setTitle(s.title);
  }

  private dropSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.beats.dispose();
    s.streamer?.dispose();
    this.clearPending(s);
    this.clearInject(s);
    if (s.streamerID) this.streamerIDs.delete(s.streamerID);
    this.sessions.delete(id);
  }

  // ---- phases --------------------------------------------------------------

  private setPhase(s: Session, phase: LiveState) {
    if (s.phase === phase) return;
    s.phase = phase;
    if (s.live) {
      this.out.toSession(s.id, {
        type: "state",
        sessionID: s.id,
        state: phase,
        blocked: s.pending ? { kind: s.pending.kind, summary: this.pendingSummary(s.pending) } : undefined,
      });
    }
  }

  private onStatus(s: Session, status: SessionStatus) {
    const prev = s.status;
    s.status = status.type;
    const r = this.root(s);
    if (status.type === "retry") {
      if (r.live && !r.retryAnnounced) {
        r.retryAnnounced = true;
        void this.askBlocked(r, `[BLOCKED]\nkind: retry\nattempt: ${status.attempt}\ndetail: ${excerpt(status.message ?? "provider not answering", 200)}`);
      }
      return;
    }
    if (status.type === "busy") {
      r.retryAnnounced = false;
      if (r.live && r.phase !== "speaking" && r.phase !== "waiting_user") this.setPhase(r, "thinking");
      return;
    }
    // idle
    if (s === r) {
      s.beats.flush("phase");
      if (s.answer) this.finishAnswer(s);
      if (r.live && !r.pending) this.setPhase(r, "listening");
      if (prev !== "idle") r.retryAnnounced = false;
    } else {
      // A child finished: its parent's window may be waiting on the clock.
      r.beats.flush("phase");
    }
  }

  private onError(s: Session, error: { name?: string; data?: unknown } | undefined) {
    const r = this.root(s);
    if (!r.live) return;
    const name = error?.name ?? "";
    if (name === "MessageAbortedError") return; // our own interrupt or the user's
    const detail = typeof (error?.data as { message?: unknown })?.message === "string" ? (error!.data as { message: string }).message : JSON.stringify(error?.data ?? {});
    void this.askBlocked(r, `[BLOCKED]\nkind: error\nname: ${name || "unknown"}\ndetail: ${excerpt(detail, 300)}`);
    this.setPhase(r, "listening");
  }

  // ---- parts ---------------------------------------------------------------

  private onPart(s: Session, part: Part) {
    s.partTypes.set(part.id, part.type);
    if (isToolPart(part)) {
      const r = this.root(s);
      if (!r.live) return;
      const via = s !== r ? s.agent ?? "sous-agent" : undefined;
      // A tool result arriving means the agent stopped talking for now.
      if (r.answer && !r.answer.suppressed) {
        // keep the answer stream open; tools between paragraphs are common
      }
      r.beats.add(part as ToolPart, via);
      r.lastBeatAt = Date.now();
      if (r.phase === "listening") this.setPhase(r, "thinking");
      return;
    }
    if (isTextPart(part)) {
      if (s.userMessages.has(part.messageID)) {
        if (part.text && !(part as { synthetic?: boolean }).synthetic) this.onUserText(s, part.text);
        return;
      }
      if ((part as { synthetic?: boolean }).synthetic || (part as { ignored?: boolean }).ignored) return;
      const r = this.root(s);
      if (s !== r || !r.live) return;
      // Reconcile: feed whatever we have not fed yet (covers missed deltas).
      const stream = this.answerFor(r, part.messageID);
      const fed = stream.fed.get(part.id) ?? 0;
      if (part.text.length > fed) {
        this.feedAnswer(r, stream, part.id, part.text.slice(fed));
      }
    }
  }

  private onTextDelta(s: Session, messageID: string, partID: string, delta: string) {
    if (s.userMessages.has(messageID)) return;
    const type = s.partTypes.get(partID);
    if (type !== "text") return; // reasoning or unknown: never spoken
    const r = this.root(s);
    if (s !== r || !r.live) return;
    const stream = this.answerFor(r, messageID);
    this.feedAnswer(r, stream, partID, delta);
  }

  private answerFor(s: Session, messageID: string): AnswerStream {
    if (s.answer && s.answer.messageID === messageID) return s.answer;
    if (s.answer) this.finishAnswer(s);
    s.beats.flush("phase");
    s.answer = {
      messageID,
      streamId: `ans_${messageID}_${Date.now().toString(36)}`,
      seq: 0,
      splitter: new SentenceSplitter({ codeNotice: this.cfg.answer.codeNotice, tableNotice: this.cfg.answer.tableNotice }),
      fed: new Map(),
      fullText: "",
      startedAt: Date.now(),
      spokenSentences: 0,
      suppressed: s.prefs.digest,
    };
    return s.answer;
  }

  private feedAnswer(s: Session, stream: AnswerStream, partID: string, delta: string) {
    stream.fed.set(partID, (stream.fed.get(partID) ?? 0) + delta.length);
    stream.fullText += delta;
    if (stream.suppressed) return;
    for (const sentence of stream.splitter.feed(delta)) this.emitAnswerSentence(s, stream, sentence, false);
  }

  private emitAnswerSentence(s: Session, stream: AnswerStream, sentence: string, end: boolean) {
    stream.spokenSentences += 1;
    this.enqueueSpeech(s, "answer", sentence, 0, { streamId: stream.streamId, streamSeq: stream.seq++, streamEnd: end });
  }

  private finishAnswer(s: Session) {
    const stream = s.answer;
    if (!stream) return;
    s.answer = undefined;
    const full = stream.fullText.trim();
    if (full) s.lastAnswer = full;
    if (!stream.suppressed) {
      const rest = stream.splitter.flush();
      rest.forEach((sentence, i) => this.emitAnswerSentence(s, stream, sentence, i === rest.length - 1));
      if (rest.length === 0 && stream.spokenSentences > 0) {
        this.out.toSession(s.id, { type: "cancel", sessionID: s.id, streamId: `${stream.streamId}#end` });
      }
      const mostlyCode = full.length >= this.cfg.answer.minAnswerCharsForDigest && codeRatio(full) >= this.cfg.answer.codeRatioForDigest;
      if (mostlyCode && stream.splitter.stats.spokenChars < 120) void this.askDigest(s, full);
      return;
    }
    if (full.length > 0) void this.askDigest(s, full);
  }

  private async askDigest(s: Session, full: string) {
    if (!s.streamer) return;
    const prompt = `[ANSWER]\nmode: digest\nprompt: ${excerpt(s.userPrompt, 300)}\nanswer:\n${full.slice(0, 6000)}`;
    const res = await this.askStreamer(s, "digest", prompt, this.cfg.streamer.voiceTimeoutMs, "reply");
    if (!res) return;
    this.applyDecisions(s, res.decisions, { spoke: res.spoke, source: "digest" });
  }

  private onUserText(s: Session, text: string) {
    const r = this.root(s);
    if (s !== r) return;
    const trimmed = text.trim();
    if (!trimmed || trimmed === s.userPrompt) return;
    s.userPrompt = trimmed;
    s.userPromptAt = Date.now();
    s.beats.flush("phase");
    if (s.answer) this.finishAnswer(s);
    s.clarify = undefined;
    if (!s.live || !s.streamer) return;
    const injected = s.injectedTexts.includes(trimmed);
    if (injected) return; // the streamer authored it
    void s.streamer.seed(`[TYPED]\n${excerpt(trimmed, 1200)}`).catch(() => undefined);
  }

  // ---- beats ---------------------------------------------------------------

  private onBeat(beat: Beat) {
    const s = this.sessions.get(beat.sessionID);
    if (!s || !s.live || !s.streamer) return;
    if (s.pending) return; // the user is being asked something; activity can wait
    const prompt = renderBeat(beat, {
      userPrompt: s.userPrompt,
      sessionTitle: s.title,
      todo: s.todo,
      elapsedSinceStartMs: s.userPromptAt ? Date.now() - s.userPromptAt : undefined,
    });
    const expiresAt = Date.now() + this.cfg.beats.ttlMs;
    void this.askStreamer(s, "beat", prompt, this.cfg.streamer.beatTimeoutMs, "beat", expiresAt).then((res) => {
      if (!res) return;
      this.applyDecisions(s, res.decisions, { spoke: res.spoke, source: "beat", expiresAt });
    });
  }

  // ---- blocked -------------------------------------------------------------

  private onPermission(s: Session, req: PermissionRequest) {
    const r = this.root(s);
    if (r.pending?.kind === "permission" && r.pending.req.id === req.id) return;
    this.clearPending(r);
    r.pending = { kind: "permission", req, repeats: 0, askedAt: Date.now() };
    if (!r.live) return;
    r.beats.flush("phase");
    this.setPhase(r, "waiting_user");
    const meta = excerpt(JSON.stringify(req.metadata ?? {}), 400);
    const via = s !== r ? `\nvia: ${s.agent ?? "sous-agent"}` : "";
    void this.askBlocked(r, `[BLOCKED]\nkind: permission\npermission: ${req.permission}\npatterns: ${req.patterns.join(", ")}\ndetail: ${meta}${via}\nanswers: once | always | reject`);
    this.scheduleRepeat(r);
  }

  private onQuestion(s: Session, req: QuestionRequest) {
    const r = this.root(s);
    if (r.pending?.kind === "question" && r.pending.req.id === req.id) return;
    this.clearPending(r);
    r.pending = { kind: "question", req, repeats: 0, askedAt: Date.now() };
    if (!r.live) return;
    r.beats.flush("phase");
    this.setPhase(r, "waiting_user");
    const qs = req.questions
      .map((q, i) => `${i + 1}. ${q.question}\n   options: ${q.options.map((o) => `"${o.label}" (${excerpt(o.description, 80)})`).join(" | ")}${q.multiple ? " (multiple allowed)" : ""}${q.custom === false ? "" : " (free answer allowed)"}`)
      .join("\n");
    void this.askBlocked(r, `[BLOCKED]\nkind: question\n${qs}`);
    this.scheduleRepeat(r);
  }

  private scheduleRepeat(s: Session) {
    const p = s.pending;
    if (!p || !this.cfg.streamer.blockedRepeatMs) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (s.pending !== p || !s.live) return;
      if (p.repeats >= this.cfg.streamer.blockedRepeatMax) return;
      p.repeats += 1;
      const text = s.lastSpoken && s.phase === "waiting_user" ? s.lastSpoken : this.pendingSummary(p);
      this.enqueueSpeech(s, "blocked", text, 0);
      this.scheduleRepeat(s);
    }, this.cfg.streamer.blockedRepeatMs);
    p.timer.unref?.();
  }

  private clearPending(s: Session) {
    if (s.pending?.timer) clearTimeout(s.pending.timer);
    const had = Boolean(s.pending);
    s.pending = undefined;
    if (had && s.live) this.setPhase(s, s.status === "busy" ? "thinking" : "listening");
  }

  private pendingSummary(p: Pending): string {
    if (p.kind === "permission") return `Permission ${p.req.permission}: ${p.req.patterns.join(", ")}`;
    return p.req.questions.map((q) => q.question).join(" ");
  }

  private async askBlocked(s: Session, prompt: string) {
    if (!s.streamer) return;
    const res = await this.askStreamer(s, "blocked", prompt, this.cfg.streamer.voiceTimeoutMs, "blocked");
    if (!res) {
      // Streamer unavailable: the user must still hear that they are needed.
      if (s.pending) this.enqueueSpeech(s, "blocked", `J'attends ta réponse. ${this.pendingSummary(s.pending)}`, 0);
      return;
    }
    this.applyDecisions(s, res.decisions, { spoke: res.spoke, source: "blocked" });
  }

  // ---- streamer plumbing ---------------------------------------------------

  private async askStreamer(
    s: Session,
    kind: "beat" | "voice" | "blocked" | "digest",
    prompt: string,
    timeoutMs: number,
    speechKind: SpeechKind,
    expiresAt = 0,
  ): Promise<{ decisions: Decision[]; spoke: boolean } | undefined> {
    if (!s.streamer) return undefined;
    const streamId = `str_${randomUUID().slice(0, 8)}`;
    const speech = { reader: new IncrementalSpeechReader(), splitter: new SentenceSplitter(), streamId, seq: 0, kind: speechKind, spoke: false };
    const result = await s.streamer.ask(kind, prompt, timeoutMs, () => {
      s.inflightSpeech = speech;
    });
    if (s.inflightSpeech === speech) s.inflightSpeech = undefined;
    if (!result || result.aborted) {
      if (speech.spoke) this.out.toSession(s.id, { type: "cancel", sessionID: s.id, streamId });
      if (result?.timedOut) this.log.warn("streamer timed out", { kind, sessionID: s.id });
      return undefined;
    }
    // Flush any speakable tail the incremental reader still holds.
    const tail = speech.reader.finish();
    const sentences = [...speech.splitter.feed(tail), ...speech.splitter.flush()];
    for (const sentence of sentences) this.emitInflight(s, speech, sentence, expiresAt);
    const untagged = kind === "beat" ? "quiet" : "say";
    const decisions = parseStreamerOutput(result.text, { untagged });
    this.log.debug("streamer decided", { kind, sessionID: s.id, decisions: decisions.map((d) => d.kind).join(","), spoke: speech.spoke });
    return { decisions, spoke: speech.spoke };
  }

  private onStreamerPart(part: Part) {
    // Streamer text parts arrive complete when the server does not stream deltas.
    const mainID = this.streamerIDs.get(part.sessionID);
    const s = mainID ? this.sessions.get(mainID) : undefined;
    if (!s?.inflightSpeech || !isTextPart(part)) return;
    const speech = s.inflightSpeech;
    const seen = (speech as { seenChars?: number }).seenChars ?? 0;
    if (part.text.length > seen) {
      (speech as { seenChars?: number }).seenChars = part.text.length;
      const chunk = speech.reader.feed(part.text.slice(seen));
      for (const sentence of speech.splitter.feed(chunk)) this.emitInflight(s, speech, sentence, 0);
    }
  }

  private onStreamerDelta(streamerID: string, delta: string) {
    const mainID = this.streamerIDs.get(streamerID);
    const s = mainID ? this.sessions.get(mainID) : undefined;
    if (!s?.inflightSpeech) return;
    const speech = s.inflightSpeech;
    (speech as { seenChars?: number }).seenChars = ((speech as { seenChars?: number }).seenChars ?? 0) + delta.length;
    const chunk = speech.reader.feed(delta);
    if (!chunk) return;
    for (const sentence of speech.splitter.feed(chunk)) this.emitInflight(s, speech, sentence, 0);
  }

  private emitInflight(s: Session, speech: NonNullable<Session["inflightSpeech"]>, sentence: string, expiresAt: number) {
    speech.spoke = true;
    this.enqueueSpeech(s, speech.kind, sentence, expiresAt, { streamId: speech.streamId, streamSeq: speech.seq++ });
  }

  private applyDecisions(s: Session, decisions: Decision[], ctx: { spoke: boolean; source: "beat" | "voice" | "blocked" | "digest"; expiresAt?: number; transcript?: string; bargeIn?: boolean }) {
    // The label shown to the user names the action taken, so an acknowledgement
    // spoken alongside an injection never hides the injection itself.
    let decisionLabel = "quiet";
    let labelRank = 0;
    const label = (text: string, rank: number) => {
      if (rank >= labelRank) {
        labelRank = rank;
        decisionLabel = text;
      }
    };
    for (const d of decisions) {
      switch (d.kind) {
        case "quiet":
          break;
        case "say":
        case "reply":
        case "clarify": {
          label(d.kind, d.kind === "clarify" ? 2 : 1);
          if (!ctx.spoke) this.enqueueSpeech(s, d.kind === "say" && ctx.source === "beat" ? "beat" : ctx.source === "blocked" ? "blocked" : "reply", d.text, ctx.expiresAt ?? 0);
          if (d.kind === "clarify") {
            s.clarify = { question: d.text, transcript: ctx.transcript ?? "", at: Date.now() };
            this.setPhase(s, "waiting_user");
          }
          break;
        }
        case "inject":
          label(`inject:${d.mode}`, 3);
          this.scheduleInject(s, d.text, d.mode);
          break;
        case "permission":
          label(`permission:${d.answer}`, 3);
          void this.answerPermission(s, d.answer);
          break;
        case "question":
          label("question", 3);
          void this.answerQuestion(s, d.answers);
          break;
        case "control":
          label(`control:${d.action}`, 3);
          this.applyControl(s, d.action);
          break;
        case "learn":
          this.registry.learn(d.heard, d.canonical);
          this.out.toSession(s.id, { type: "lexicon", sessionID: s.id, phrases: this.phrasesFor(s.id) });
          break;
      }
    }
    if (ctx.transcript !== undefined) {
      const corrected = decisions.find((d) => d.kind === "inject") as Extract<Decision, { kind: "inject" }> | undefined;
      s.lastHeard = { raw: ctx.transcript, corrected: corrected?.text ?? ctx.transcript };
      this.out.toSession(s.id, { type: "heard", sessionID: s.id, raw: ctx.transcript, corrected: corrected?.text ?? ctx.transcript, decision: decisionLabel });
      if (ctx.bargeIn) {
        // Barge-in that led nowhere: let the cockpit continue what it was saying.
        const quiet = decisions.every((d) => d.kind === "quiet" || d.kind === "learn");
        if (quiet) this.out.toSession(s.id, { type: "resume", sessionID: s.id });
        else this.out.toSession(s.id, { type: "cancel", sessionID: s.id });
      }
    }
  }

  // ---- speech --------------------------------------------------------------

  private enqueueSpeech(s: Session, kind: SpeechKind, text: string, expiresAt: number, stream?: { streamId: string; streamSeq: number; streamEnd?: boolean }) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || !s.live) return;
    if (s.prefs.muted && kind !== "blocked") return;
    const utterance: Utterance = {
      id: `utt_${randomUUID().slice(0, 10)}`,
      sessionID: s.id,
      kind,
      text: clean,
      expiresAt,
      streamId: stream?.streamId,
      streamSeq: stream?.streamSeq,
      streamEnd: stream?.streamEnd,
    };
    if (kind !== "answer" || !stream || stream.streamSeq === 0) s.lastSpoken = clean;
    else s.lastSpoken = (s.lastSpoken ? s.lastSpoken + " " : "") + clean;
    if (kind === "blocked" && s.status !== "idle" && s.phase !== "waiting_user") this.setPhase(s, "waiting_user");
    this.out.speak(utterance);
    this.log.debug("speak", { sessionID: s.id, kind, text: clean.slice(0, 120) });
  }

  onSpoken(sessionID: string, utteranceId: string, completed: boolean, heardText?: string) {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    if (completed && s.phase === "speaking") this.setPhase(s, s.status === "busy" ? "thinking" : s.pending ? "waiting_user" : "listening");
    if (heardText !== undefined && s.streamer && !completed) {
      void s.streamer.seed(`[HEARD]\nKπX heard only this before cutting in: ${excerpt(heardText, 300)}`).catch(() => undefined);
    }
  }

  onSpeakingStarted(sessionID: string) {
    const s = this.sessions.get(sessionID);
    if (s && s.phase !== "waiting_user") this.setPhase(s, "speaking");
  }

  // ---- voice ---------------------------------------------------------------

  onBargeIn(sessionID: string) {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    s.streamer?.dropBeats();
    this.setPhase(s, "interrupted");
  }

  onBargeInFalse(sessionID: string) {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    if (s.phase === "interrupted") this.setPhase(s, "speaking");
  }

  async onTranscript(sessionID: string, text: string, opts: { bargeIn: boolean; spokenOver?: string; lang?: string }): Promise<string> {
    const s = this.sessions.get(sessionID) ?? this.ensureSession(sessionID, "");
    const raw = text.trim();
    if (!raw) return "empty";
    if (!s.live) {
      await this.setLive(sessionID, true);
    }
    if (!s.streamer) {
      await this.startStreamer(s);
      if (!s.streamer) return "no-streamer";
    }
    s.streamer.dropBeats();
    this.setPhase(s, "thinking");
    const lexicon = await this.lexiconFor(s.directory);
    const candidates = candidatesFor(raw, lexicon, this.registry.aliases(), { limit: this.cfg.lexicon.candidateTerms });
    const lines = ["[VOICE]", `transcript: ${raw}`];
    if (opts.lang) lines.push(`recognizer language: ${opts.lang}`);
    lines.push(`session is ${s.status}${s.answer ? " and answering" : ""}`);
    if (opts.bargeIn) lines.push(`KπX cut you off while you were saying: ${excerpt(opts.spokenOver ?? s.lastSpoken ?? "", 300)}`);
    else if (s.lastSpoken) lines.push(`last thing you said: ${excerpt(s.lastSpoken, 200)}`);
    if (s.pending?.kind === "permission") {
      lines.push(`pending permission: ${s.pending.req.permission} on ${s.pending.req.patterns.join(", ")} (answers: once | always | reject)`);
    } else if (s.pending?.kind === "question") {
      lines.push(`pending question: ${s.pending.req.questions.map((q) => `${q.question} [${q.options.map((o) => o.label).join(" | ")}]`).join(" ; ")}`);
    }
    if (s.clarify) lines.push(`you asked for clarification: "${excerpt(s.clarify.question, 200)}" about: "${excerpt(s.clarify.transcript, 200)}"`);
    if (s.userPrompt) lines.push(`current task: ${excerpt(s.userPrompt, 300)}`);
    if (s.lastAnswer) lines.push(`latest answer (excerpt): ${excerpt(s.lastAnswer, 500)}`);
    if (s.todo) lines.push(`plan: ${excerpt(s.todo, 300)}`);
    if (candidates.length) {
      lines.push("project terms that sound like parts of the transcript (heard → term):");
      for (const c of candidates) lines.push(`- "${c.heard}" → ${c.term}`);
    }
    const res = await this.askStreamer(s, "voice", lines.join("\n"), this.cfg.streamer.voiceTimeoutMs, "reply");
    if (!res) {
      // The streamer is unreachable: the safest useful thing is to queue the raw text.
      this.log.warn("voice: streamer unavailable, injecting raw transcript", { sessionID });
      this.scheduleInject(s, raw, "queue");
      this.out.toSession(s.id, { type: "heard", sessionID: s.id, raw, corrected: raw, decision: "inject:queue(fallback)" });
      return "inject:fallback";
    }
    const hadClarify = Boolean(s.clarify);
    if (hadClarify && !res.decisions.some((d) => d.kind === "clarify")) s.clarify = undefined;
    this.applyDecisions(s, res.decisions, { spoke: res.spoke, source: "voice", transcript: raw, bargeIn: opts.bargeIn });
    if (s.phase === "thinking" && !s.clarify) this.setPhase(s, s.status === "busy" ? "thinking" : s.pending ? "waiting_user" : "listening");
    return res.decisions.map((d) => d.kind).join(",");
  }

  // ---- actions on the main session ----------------------------------------

  private scheduleInject(s: Session, text: string, mode: "queue" | "interrupt") {
    this.clearInject(s);
    const id = `inj_${randomUUID().slice(0, 8)}`;
    const delay = this.cfg.streamer.injectDelayMs;
    const timer = setTimeout(() => {
      s.pendingInject = undefined;
      void this.executeInject(s, id, text, mode);
    }, delay);
    s.pendingInject = { id, text, mode, timer };
    this.out.toSession(s.id, { type: "inject_pending", sessionID: s.id, injectId: id, text, mode, executeAt: Date.now() + delay });
  }

  cancelInject(sessionID: string, injectId: string): boolean {
    const s = this.sessions.get(sessionID);
    if (!s?.pendingInject || s.pendingInject.id !== injectId) return false;
    this.clearInject(s);
    this.out.toSession(s.id, { type: "inject_done", sessionID: s.id, injectId, ok: false, error: "cancelled" });
    return true;
  }

  private clearInject(s: Session) {
    if (s.pendingInject) clearTimeout(s.pendingInject.timer);
    s.pendingInject = undefined;
  }

  private async executeInject(s: Session, id: string, text: string, mode: "queue" | "interrupt") {
    try {
      if (mode === "interrupt" && s.status === "busy") {
        await this.client.abort(s.id, s.directory);
        await this.waitForIdle(s, 4000);
      }
      s.injectedTexts.push(text);
      if (s.injectedTexts.length > 20) s.injectedTexts.shift();
      await this.client.promptAsync(s.id, s.directory, {
        agent: s.agent,
        model: s.model && s.model.modelID ? s.model : undefined,
        parts: [{ type: "text", text }],
      });
      this.out.toSession(s.id, { type: "inject_done", sessionID: s.id, injectId: id, ok: true });
      this.log.info("injected", { sessionID: s.id, mode, text: text.slice(0, 120) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error("inject failed", { sessionID: s.id, error: msg });
      this.out.toSession(s.id, { type: "inject_done", sessionID: s.id, injectId: id, ok: false, error: msg });
      this.enqueueSpeech(s, "system", "Je n'ai pas réussi à transmettre ta consigne, réessaie.", 0);
    }
  }

  private waitForIdle(s: Session, timeoutMs: number): Promise<void> {
    if (s.status === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (s.status === "idle" || Date.now() - started > timeoutMs) return resolve();
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  private async answerPermission(s: Session, answer: "once" | "always" | "reject") {
    const p = s.pending;
    if (p?.kind !== "permission") {
      this.enqueueSpeech(s, "system", "Il n'y a plus de permission en attente.", 0);
      return;
    }
    try {
      await this.client.respondPermission(s.id, s.directory, p.req.id, answer);
      this.clearPending(s);
    } catch (e) {
      this.log.error("permission reply failed", { error: e instanceof Error ? e.message : String(e) });
      this.enqueueSpeech(s, "system", "Je n'ai pas réussi à répondre à la permission.", 0);
    }
  }

  private async answerQuestion(s: Session, answers: string[][]) {
    const p = s.pending;
    if (p?.kind !== "question") {
      this.enqueueSpeech(s, "system", "Il n'y a plus de question en attente.", 0);
      return;
    }
    try {
      // Map spoken labels onto the real option labels when they are close.
      const mapped = p.req.questions.map((q, i) => {
        const given = answers[i] ?? answers[0] ?? [];
        return given.map((a) => q.options.find((o) => o.label.toLowerCase() === a.toLowerCase())?.label ?? a);
      });
      await this.client.replyQuestion(s.directory, p.req.id, mapped);
      this.clearPending(s);
    } catch (e) {
      this.log.error("question reply failed", { error: e instanceof Error ? e.message : String(e) });
      this.enqueueSpeech(s, "system", "Je n'ai pas réussi à transmettre ta réponse.", 0);
    }
  }

  applyControl(s: Session, action: ControlAction) {
    switch (action) {
      case "mute":
        s.prefs.muted = true;
        this.registry.setPrefs(s.id, { muted: true });
        this.out.toSession(s.id, { type: "control", sessionID: s.id, action });
        break;
      case "unmute":
        s.prefs.muted = false;
        this.registry.setPrefs(s.id, { muted: false });
        this.out.toSession(s.id, { type: "control", sessionID: s.id, action });
        break;
      case "stop":
        this.out.toSession(s.id, { type: "cancel", sessionID: s.id });
        s.streamer?.dropBeats();
        break;
      case "repeat":
        if (s.lastSpoken) this.enqueueSpeech(s, "reply", s.lastSpoken, 0);
        break;
      case "slower":
      case "faster":
        this.out.toSession(s.id, { type: "control", sessionID: s.id, action });
        break;
      case "digest":
      case "full":
        s.prefs.digest = action === "digest";
        this.registry.setPrefs(s.id, { digest: s.prefs.digest });
        if (s.answer) s.answer.suppressed = s.prefs.digest;
        this.out.toSession(s.id, { type: "control", sessionID: s.id, action });
        break;
    }
  }

  setPrefs(sessionID: string, prefs: { digest?: boolean; muted?: boolean }) {
    const s = this.sessions.get(sessionID);
    if (!s) return;
    if (prefs.digest !== undefined) s.prefs.digest = prefs.digest;
    if (prefs.muted !== undefined) s.prefs.muted = prefs.muted;
    this.registry.setPrefs(sessionID, prefs);
  }

  private async reseed(s: Session) {
    if (!s.streamer) return;
    const lexicon = await this.lexiconFor(s.directory);
    await s.streamer.seed(this.contextBlock(s, lexicon)).catch(() => undefined);
  }

  /** Called on startup: re-attach persisted bindings so restarts are seamless. */
  restoreBindings() {
    for (const [mainID, binding] of Object.entries(this.registry.bindings())) {
      const s = this.ensureSession(mainID, binding.directory);
      s.streamerID = binding.streamerID;
      this.streamerIDs.set(binding.streamerID, mainID);
    }
  }

  dispose() {
    for (const s of this.sessions.values()) {
      s.beats.dispose();
      s.streamer?.dispose();
      if (s.pending?.timer) clearTimeout(s.pending.timer);
      this.clearInject(s);
    }
    for (const t of this.lexiconRefresh.values()) clearTimeout(t);
  }
}
