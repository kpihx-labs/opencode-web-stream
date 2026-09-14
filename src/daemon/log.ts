import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";

/**
 * Standard structured logging on top of pino.
 *
 * - Levels follow the usual ladder: trace, debug, info, warn, error, fatal.
 * - Every record is one JSON line on stdout with a stable shape, so journald,
 *   `jq`, Loki or Vector can consume it without a custom parser.
 * - Child loggers carry a `scope` and any long-lived binding (session id,
 *   directory), so a whole conversation can be filtered with one predicate.
 * - The last records are kept in memory and served at `/api/logs`, which is
 *   what the cockpit's diagnostics panel reads.
 *
 * Set `OPENCODE_WEB_STREAM_LOG` to the level, and `OPENCODE_WEB_STREAM_PRETTY=1`
 * for human-readable output when running by hand.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogRecord = {
  time: number;
  level: LogLevel;
  scope: string;
  msg: string;
  [key: string]: unknown;
};

export type LoggerOpts = {
  level?: LogLevel;
  /** Records kept for `/api/logs`. */
  ringSize?: number;
  pretty?: boolean;
  /** Test seam: receive every record instead of writing to stdout. */
  onRecord?: (record: LogRecord) => void;
  name?: string;
};

const LEVEL_NAMES: Record<number, LogLevel> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export class Logger {
  private readonly ring: LogRecord[] = [];
  private readonly ringSize: number;
  readonly pino: PinoLogger;

  constructor(opts: LoggerOpts = {}) {
    this.ringSize = opts.ringSize ?? 500;
    const level = opts.level ?? "info";
    const keep = (record: LogRecord) => {
      this.ring.push(record);
      if (this.ring.length > this.ringSize) this.ring.shift();
      opts.onRecord?.(record);
    };
    const options: LoggerOptions = {
      name: opts.name ?? "opencode-web-stream",
      level,
      base: { pid: process.pid },
      formatters: {
        level(label, number) {
          return { level: LEVEL_NAMES[number] ?? label };
        },
      },
      redact: { paths: ["password", "*.password", "authorization", "*.authorization"], censor: "[redacted]" },
      hooks: {
        logMethod(args, method, levelNumber) {
          const [first, second] = args as [unknown, unknown];
          const bindings = (this as unknown as { bindings(): Record<string, unknown> }).bindings();
          const merged = typeof first === "object" && first !== null ? (first as Record<string, unknown>) : {};
          const msg = typeof first === "string" ? first : typeof second === "string" ? second : "";
          keep({
            time: Date.now(),
            level: LEVEL_NAMES[levelNumber] ?? "info",
            scope: String(bindings.scope ?? "root"),
            msg,
            ...stripInternals({ ...bindings, ...merged }),
          });
          return method.apply(this, args as never);
        },
      },
    };
    const pretty = opts.pretty ?? process.env.OPENCODE_WEB_STREAM_PRETTY === "1";
    this.pino = pretty
      ? pino({ ...options, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,name" } } })
      : pino(options);
  }

  scope(scope: string, bindings: Record<string, unknown> = {}): ScopedLogger {
    return new ScopedLogger(this.pino.child({ scope, ...bindings }));
  }

  setLevel(level: LogLevel) {
    this.pino.level = level;
  }

  get level(): string {
    return this.pino.level;
  }

  /** Recent records, newest last, for the diagnostics endpoint. */
  recent(limit = 100): LogRecord[] {
    return this.ring.slice(-Math.max(1, Math.min(limit, this.ringSize)));
  }
}

/**
 * A scoped logger. Call signature mirrors pino's: `log.info({ ...fields }, "message")`,
 * with a convenience overload `log.info("message", { ...fields })` so call sites
 * read naturally.
 */
export class ScopedLogger {
  constructor(readonly pino: PinoLogger) {}

  child(bindings: Record<string, unknown>): ScopedLogger {
    return new ScopedLogger(this.pino.child(bindings));
  }

  trace(msg: string, data?: Record<string, unknown>) {
    this.emit("trace", msg, data);
  }
  debug(msg: string, data?: Record<string, unknown>) {
    this.emit("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>) {
    this.emit("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>) {
    this.emit("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>) {
    this.emit("error", msg, data);
  }
  fatal(msg: string, data?: Record<string, unknown>) {
    this.emit("fatal", msg, data);
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>) {
    if (data) this.pino[level](normalize(data), msg);
    else this.pino[level](msg);
  }
}

/** Errors become `{ message, stack }`; everything else passes through. */
function normalize(data: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) {
      out ??= { ...data };
      out[k] = { message: v.message, stack: v.stack };
    }
  }
  return out ?? data;
}

function stripInternals(obj: Record<string, unknown>): Record<string, unknown> {
  const { pid, hostname, name, scope, ...rest } = obj;
  void pid;
  void hostname;
  void name;
  void scope;
  return rest;
}
