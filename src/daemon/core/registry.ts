import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Persistent state that must survive a daemon or OpenCode restart:
 * which streamer session belongs to which main session, per-session
 * preferences, and the aliases the streamer has learned from speech.
 */

export type StreamerBinding = {
  streamerID: string;
  directory: string;
  createdAt: number;
  prompts: number;
  lastSeedAt: number;
};

export type SessionPrefs = { digest?: boolean; muted?: boolean };

export type Alias = { heard: string; canonical: string; count: number; updatedAt: number };

type RegistryFile = {
  version: 1;
  streamers: Record<string, StreamerBinding>;
  prefs: Record<string, SessionPrefs>;
  aliases: Alias[];
};

const EMPTY: RegistryFile = { version: 1, streamers: {}, prefs: {}, aliases: [] };

export class Registry {
  private data: RegistryFile;
  private saveTimer: NodeJS.Timeout | undefined;
  readonly path: string;

  constructor(dataDir: string, private readonly debounceMs = 250) {
    this.path = join(dataDir, "registry.json");
    this.data = load(this.path);
  }

  binding(sessionID: string): StreamerBinding | undefined {
    return this.data.streamers[sessionID];
  }

  bindings(): Record<string, StreamerBinding> {
    return { ...this.data.streamers };
  }

  bind(sessionID: string, binding: StreamerBinding) {
    this.data.streamers[sessionID] = binding;
    this.scheduleSave();
  }

  touch(sessionID: string, patch: Partial<StreamerBinding>) {
    const cur = this.data.streamers[sessionID];
    if (!cur) return;
    Object.assign(cur, patch);
    this.scheduleSave();
  }

  unbind(sessionID: string) {
    if (delete this.data.streamers[sessionID]) this.scheduleSave();
  }

  prefs(sessionID: string): SessionPrefs {
    return { ...(this.data.prefs[sessionID] ?? {}) };
  }

  setPrefs(sessionID: string, patch: SessionPrefs) {
    this.data.prefs[sessionID] = { ...(this.data.prefs[sessionID] ?? {}), ...patch };
    this.scheduleSave();
  }

  aliases(): Alias[] {
    return this.data.aliases.slice();
  }

  learn(heard: string, canonical: string) {
    const h = heard.trim().toLowerCase();
    const c = canonical.trim();
    if (!h || !c || h === c.toLowerCase()) return;
    const existing = this.data.aliases.find((a) => a.heard === h);
    if (existing) {
      existing.canonical = c;
      existing.count += 1;
      existing.updatedAt = Date.now();
    } else {
      this.data.aliases.push({ heard: h, canonical: c, count: 1, updatedAt: Date.now() });
      if (this.data.aliases.length > 2000) this.data.aliases.splice(0, this.data.aliases.length - 2000);
    }
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, this.debounceMs);
    this.saveTimer.unref?.();
  }

  saveNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}

function load(path: string): RegistryFile {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RegistryFile>;
    return {
      version: 1,
      streamers: parsed.streamers ?? {},
      prefs: parsed.prefs ?? {},
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases : [],
    };
  } catch {
    return structuredClone(EMPTY);
  }
}
