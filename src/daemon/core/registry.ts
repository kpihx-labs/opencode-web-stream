import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
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

export type SessionPrefs = { digest?: boolean; muted?: boolean; lang?: string };

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
  private hexCache: { mtimeMs: number; aliases: Alias[] } = { mtimeMs: -1, aliases: [] };
  readonly path: string;
  readonly hexSettingsPath: string;

  constructor(dataDir: string, private readonly debounceMs = 250, hexSettingsPath?: string) {
    this.path = join(dataDir, "registry.json");
    const isTempTest = !hexSettingsPath && dataDir.startsWith(tmpdir());
    this.hexSettingsPath = hexSettingsPath ?? (isTempTest ? join(dataDir, "hex-settings.json") : join(homedir(), ".local", "share", "hex", "settings.json"));
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
    return { ...this.data.prefs[sessionID] };
  }

  setPrefs(sessionID: string, patch: SessionPrefs) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.data.prefs[sessionID] = { ...this.data.prefs[sessionID], ...defined };
    this.scheduleSave();
  }

  aliases(): Alias[] {
    const hexAliases = this.loadHexAliases();
    if (!hexAliases.length) return this.data.aliases.slice();
    const byHeard = new Map<string, Alias>();
    for (const a of hexAliases) byHeard.set(a.heard, a);
    // Learned session aliases override or boost static Hex entries.
    for (const a of this.data.aliases) byHeard.set(a.heard, a);
    return [...byHeard.values()];
  }

  private loadHexAliases(): Alias[] {
    try {
      if (!existsSync(this.hexSettingsPath)) return [];
      const st = statSync(this.hexSettingsPath);
      if (st.mtimeMs === this.hexCache.mtimeMs) return this.hexCache.aliases;
      const raw = JSON.parse(readFileSync(this.hexSettingsPath, "utf8")) as {
        vocabulary?: Array<{ term?: unknown; sounds_like?: unknown }>;
      };
      const out: Alias[] = [];
      for (const entry of raw.vocabulary ?? []) {
        const canonical = typeof entry?.term === "string" ? entry.term.trim() : "";
        if (!canonical) continue;
        const sounds = Array.isArray(entry.sounds_like) ? entry.sounds_like : [];
        for (const s of sounds) {
          const heard = typeof s === "string" ? s.trim().toLowerCase() : "";
          if (heard && heard !== canonical.toLowerCase()) {
            out.push({ heard, canonical, count: 3, updatedAt: 0 });
          }
        }
      }
      this.hexCache = { mtimeMs: st.mtimeMs, aliases: out };
      return out;
    } catch {
      return [];
    }
  }

  learn(heard: string, canonical: string, syncHex = true) {
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
    if (syncHex && existsSync(this.hexSettingsPath)) {
      execFile("hex", ["vocabulary", "add", c, "--sounds-like", heard.trim()], { timeout: 3000 }, () => undefined);
    }
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
