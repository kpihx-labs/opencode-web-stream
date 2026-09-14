import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Daemon configuration. Precedence: environment > config file > defaults.
 * The file lives at ~/.config/opencode-web-stream/config.json (override with
 * OPENCODE_WEB_STREAM_CONFIG). Every value has a working default so the daemon
 * starts on a bare machine; only the OpenCode URL usually needs adjusting.
 */

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  opencode: {
    url: string;
    username: string;
    password: string;
    /** Directories whose sessions the daemon may narrate; empty = all. */
    directories: string[];
  };
  streamer: {
    agent: string;
    model: string;
    /** Abandon a beat the streamer has not answered within this budget. */
    beatTimeoutMs: number;
    /** A voice turn must be answered within this budget. */
    voiceTimeoutMs: number;
    /** Summarize the streamer session past this many prompts. */
    summarizeEveryPrompts: number;
    /** Wait this long before executing an injection so the cockpit can cancel it. */
    injectDelayMs: number;
    /** Repeat an unanswered permission or question after this delay (0 = never). */
    blockedRepeatMs: number;
    blockedRepeatMax: number;
  };
  beats: {
    windowMs: number;
    maxTools: number;
    ttlMs: number;
    inputChars: number;
    outputChars: number;
  };
  answer: {
    /** full = read the answer as it streams; digest = let the streamer summarize. */
    mode: "full" | "digest";
    /** Above this share of code characters the answer is digested even in full mode. */
    codeRatioForDigest: number;
    /** Spoken once when a code block is skipped. */
    codeNotice: string;
    tableNotice: string;
    minAnswerCharsForDigest: number;
  };
  stt: {
    /** OpenAI-compatible transcription endpoint; empty disables server STT. */
    url: string;
    model: string;
    language: string;
    promptTerms: number;
    timeoutMs: number;
  };
  tts: {
    /** OpenAI-compatible speech endpoint; empty disables server TTS. */
    url: string;
    model: string;
    voice: string;
    format: "wav" | "mp3" | "opus" | "flac" | "pcm";
    speed: number;
    timeoutMs: number;
  };
  lexicon: {
    maxFiles: number;
    maxTerms: number;
    contextTerms: number;
    phraseTerms: number;
    candidateTerms: number;
    refreshDebounceMs: number;
  };
};

export const DEFAULTS: Config = {
  host: "127.0.0.1",
  port: 8765,
  dataDir: join(homedir(), ".local", "share", "opencode-web-stream"),
  logLevel: "info",
  opencode: {
    url: "http://127.0.0.1:40977",
    username: "opencode",
    password: "",
    directories: [],
  },
  streamer: {
    agent: "streamer",
    model: "opencode-go/muse-spark-1.3-contributor",
    beatTimeoutMs: 9000,
    voiceTimeoutMs: 20000,
    summarizeEveryPrompts: 80,
    injectDelayMs: 1500,
    blockedRepeatMs: 45000,
    blockedRepeatMax: 2,
  },
  beats: {
    windowMs: 2500,
    maxTools: 6,
    ttlMs: 9000,
    inputChars: 220,
    outputChars: 320,
  },
  answer: {
    mode: "full",
    codeRatioForDigest: 0.5,
    codeNotice: "Je te mets le code à l'écran.",
    tableNotice: "Je t'affiche un tableau à l'écran.",
    minAnswerCharsForDigest: 600,
  },
  stt: {
    url: "http://127.0.0.1:8000/v1/audio/transcriptions",
    model: "Systran/faster-whisper-large-v3",
    language: "fr",
    promptTerms: 60,
    timeoutMs: 20000,
  },
  tts: {
    url: "http://127.0.0.1:8000/v1/audio/speech",
    model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
    voice: "ff_siwis",
    format: "wav",
    speed: 1.05,
    timeoutMs: 15000,
  },
  lexicon: {
    maxFiles: 6000,
    maxTerms: 4000,
    contextTerms: 300,
    phraseTerms: 100,
    candidateTerms: 8,
    refreshDebounceMs: 4000,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_WEB_STREAM_CONFIG ?? join(homedir(), ".config", "opencode-web-stream", "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, file?: string): Config {
  const path = file ?? configPath(env);
  let fromFile: DeepPartial<Config> = {};
  if (existsSync(path)) {
    fromFile = JSON.parse(readFileSync(path, "utf8")) as DeepPartial<Config>;
  }
  const merged = mergeConfig(DEFAULTS, fromFile);
  applyEnv(merged, env);
  return merged;
}

export function mergeConfig(base: Config, patch: DeepPartial<Config>): Config {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = { ...current, ...(value as Record<string, unknown>) };
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Config;
}

function applyEnv(cfg: Config, env: NodeJS.ProcessEnv) {
  if (env.OPENCODE_WEB_STREAM_HOST) cfg.host = env.OPENCODE_WEB_STREAM_HOST;
  if (env.OPENCODE_WEB_STREAM_PORT) cfg.port = Number(env.OPENCODE_WEB_STREAM_PORT);
  if (env.OPENCODE_WEB_STREAM_DATA) cfg.dataDir = env.OPENCODE_WEB_STREAM_DATA;
  if (env.OPENCODE_WEB_STREAM_LOG) cfg.logLevel = env.OPENCODE_WEB_STREAM_LOG as Config["logLevel"];
  if (env.OPENCODE_URL) cfg.opencode.url = env.OPENCODE_URL;
  else if (env.OPENCODE_WEB_PORT) cfg.opencode.url = `http://127.0.0.1:${env.OPENCODE_WEB_PORT}`;
  if (env.OPENCODE_SERVER_PASSWORD) cfg.opencode.password = env.OPENCODE_SERVER_PASSWORD;
  if (env.OPENCODE_SERVER_USERNAME) cfg.opencode.username = env.OPENCODE_SERVER_USERNAME;
  if (env.OPENCODE_WEB_STREAM_MODEL) cfg.streamer.model = env.OPENCODE_WEB_STREAM_MODEL;
  if (env.OPENCODE_WEB_STREAM_AGENT) cfg.streamer.agent = env.OPENCODE_WEB_STREAM_AGENT;
  if (env.OPENCODE_WEB_STREAM_STT_URL !== undefined) cfg.stt.url = env.OPENCODE_WEB_STREAM_STT_URL;
  if (env.OPENCODE_WEB_STREAM_TTS_URL !== undefined) cfg.tts.url = env.OPENCODE_WEB_STREAM_TTS_URL;
  if (env.OPENCODE_WEB_STREAM_TTS_VOICE) cfg.tts.voice = env.OPENCODE_WEB_STREAM_TTS_VOICE;
  if (env.OPENCODE_WEB_STREAM_STT_LANG) cfg.stt.language = env.OPENCODE_WEB_STREAM_STT_LANG;
  cfg.opencode.url = cfg.opencode.url.replace(/\/+$/, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
