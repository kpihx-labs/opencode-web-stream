/**
 * Wire protocol shared by the daemon and the browser cockpit.
 *
 * Every message on the websocket is a `ServerMessage` (daemon -> browser) or a
 * `ClientMessage` (browser -> daemon). The protocol is versioned: a cockpit
 * whose `PROTOCOL_VERSION` does not match the daemon's is told to reload
 * instead of silently misbehaving.
 */

export const PROTOCOL_VERSION = 5;

/** Lifecycle of one live session, mirrored on both sides. */
export type LiveState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "waiting_user"
  | "away";

/** Why a spoken utterance exists. Drives ordering and preemption. */
export type SpeechKind = "blocked" | "reply" | "answer" | "beat" | "system";

/**
 * Priority of a spoken utterance. Higher wins; a strictly higher priority
 * utterance preempts whatever is currently playing.
 */
export const SPEECH_PRIORITY: Record<SpeechKind, number> = {
  blocked: 40,
  reply: 30,
  answer: 20,
  beat: 10,
  system: 35,
};

/** One unit of speech handed to the cockpit. */
export type Utterance = {
  /** Stable id so a repeat or a cancel can address it. */
  id: string;
  sessionID: string;
  kind: SpeechKind;
  text: string;
  /** Wall clock ms at which the text stopped being true. 0 means never. */
  expiresAt: number;
  /** Utterances sharing a streamId are one continuous read (the final answer). */
  streamId?: string;
  /** Index inside the stream, so late chunks cannot jump the queue. */
  streamSeq?: number;
  /** Last chunk of a stream; lets the cockpit release the stream lock. */
  streamEnd?: boolean;
  /** Session title, spoken as a prefix when several sessions are live. */
  sessionLabel?: string;
  /** Two-letter language of the text, so the right voice reads it. */
  lang?: string;
};

export type SessionSnapshot = {
  sessionID: string;
  title: string;
  directory: string;
  state: LiveState;
  live: boolean;
  /** Present while a permission or question is pending. */
  blocked?: { kind: "permission" | "question"; summary: string };
  /** Last thing the daemon said, for the subtitle strip after a reload. */
  lastSpoken?: string;
  /** Last transcript the daemon accepted, raw then corrected. */
  lastHeard?: { raw: string; corrected: string };
  /** Two-letter code of the language the user last spoke in. */
  lang: string;
};

export type DaemonStatus = {
  protocol: number;
  opencode: { connected: boolean; url: string; lastError?: string };
  tts: { engine: "server" | "browser"; ready: boolean; voice?: string };
  stt: { engine: "browser" | "server"; ready: boolean };
  /** Languages the daemon is configured for; the cockpit offers these plus "auto". */
  speech: { languages: string[]; default: string };
  sessions: SessionSnapshot[];
};

export type ServerMessage =
  | { type: "hello"; status: DaemonStatus; speakerToken: string }
  | { type: "status"; status: DaemonStatus }
  | { type: "state"; sessionID: string; state: LiveState; blocked?: SessionSnapshot["blocked"] }
  | { type: "speak"; utterance: Utterance }
  /** Cancel one utterance, one stream, or everything for a session. */
  | { type: "cancel"; sessionID: string; utteranceId?: string; streamId?: string }
  /** A barge-in turned out to be noise or a side remark: continue where audio stopped. */
  | { type: "resume"; sessionID: string }
  /** An injection is scheduled; the cockpit shows it and may cancel it before `executeAt`. */
  | { type: "inject_pending"; sessionID: string; injectId: string; text: string; mode: "queue" | "interrupt"; executeAt: number }
  | { type: "inject_done"; sessionID: string; injectId: string; ok: boolean; error?: string }
  /** Ask the cockpit to stop listening/speaking entirely (mute toggled remotely). */
  | { type: "control"; sessionID: string; action: ControlAction }
  /** Echo of what the daemon understood, for the subtitle strip. */
  | { type: "heard"; sessionID: string; raw: string; corrected: string; decision: string }
  /** Vocabulary for the recognizer's contextual biasing. */
  | { type: "lexicon"; sessionID: string; phrases: string[] }
  /**
   * A session was created for a cockpit that had none (the user spoke on the
   * new-session page). The cockpit follows, so the conversation is visible
   * exactly as if they had typed and pressed enter.
   */
  | { type: "navigate"; sessionID: string; directory: string; url: string }
  | { type: "error"; message: string }
  | { type: "reload"; reason: string }
  | { type: "pong"; t: number };

export type ControlAction =
  | "mute"
  | "unmute"
  | "stop"
  | "repeat"
  | "slower"
  | "faster"
  | "digest"
  | "full";

export type ClientMessage =
  /** Cockpit announces itself and the session it is looking at. */
  | { type: "attach"; sessionID: string; directory?: string; protocol: number; visible: boolean }
  | { type: "detach"; sessionID: string }
  /** Live mode toggled from the cockpit button. `sessionID` is empty on the new-session page. */
  | { type: "live"; sessionID: string; enabled: boolean; directory?: string; lang?: string }
  /** A final transcript. `spokenOver` is what the user heard before cutting in. */
  | {
      type: "transcript";
      sessionID: string;
      text: string;
      spokenOver?: string;
      bargeIn: boolean;
      lang?: string;
      /** Set when `sessionID` is empty: where to create the session. */
      directory?: string;
    }
  /** The user started speaking while we were talking: stop audio now. */
  | { type: "barge_in"; sessionID: string; spokenOver?: string }
  /** No transcript followed a barge-in: the cockpit resumed on its own. */
  | { type: "barge_in_false"; sessionID: string }
  /** The cockpit finished (or gave up on) an utterance. */
  | { type: "spoken"; sessionID: string; utteranceId: string; completed: boolean; heardText?: string }
  /** Cockpit-local preference changes worth persisting server-side. */
  | { type: "prefs"; sessionID: string; digest?: boolean; muted?: boolean; lang?: string }
  /** Direct control from a cockpit button rather than from voice. */
  | { type: "control"; sessionID: string; action: ControlAction }
  | { type: "visible"; sessionID: string; visible: boolean }
  /** Cancel a scheduled injection before it executes. */
  | { type: "cancel_inject"; sessionID: string; injectId: string }
  | { type: "ping"; t: number };

/** Server-sent speech chunk sizes; kept here so both sides agree. */
export const MAX_UTTERANCE_CHARS = 420;
