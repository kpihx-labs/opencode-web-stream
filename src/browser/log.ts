/**
 * Cockpit logging.
 *
 * Same levels and the same discipline as the daemon's pino logger, kept tiny
 * because it ships to the browser. Records go to the console with a stable
 * prefix and into a ring buffer exposed on `window.__opencodeWebStream.logs()`,
 * so a problem reported from a phone can be read back without a debugger.
 */

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_SIZE = 200;
const PREFIX = "[web-stream]";
const STORAGE_KEY = "opencodeWebStream.logLevel";

type Record_ = { t: number; level: Level; msg: string; data: unknown[] };

const ring: Record_[] = [];
let level: Level = readLevel();

function readLevel(): Level {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && saved in ORDER) return saved as Level;
  } catch {
    // storage may be blocked; the default is fine
  }
  return "info";
}

function emit(lvl: Level, msg: string, data: unknown[]) {
  ring.push({ t: Date.now(), level: lvl, msg, data });
  if (ring.length > RING_SIZE) ring.shift();
  if (ORDER[lvl] < ORDER[level]) return;
  const method = lvl === "debug" ? console.debug : lvl === "info" ? console.info : lvl === "warn" ? console.warn : console.error;
  method(`${PREFIX} ${msg}`, ...data);
}

export const log = {
  debug: (msg: string, ...data: unknown[]) => emit("debug", msg, data),
  info: (msg: string, ...data: unknown[]) => emit("info", msg, data),
  warn: (msg: string, ...data: unknown[]) => emit("warn", msg, data),
  error: (msg: string, ...data: unknown[]) => emit("error", msg, data),
  setLevel(next: Level) {
    level = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not persisted, still applied for this page
    }
  },
  get level(): Level {
    return level;
  },
  records(): Record_[] {
    return ring.slice();
  },
};
