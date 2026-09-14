import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { splitIdentifier, words } from "./tokenize.js";
import { phoneticKeys } from "./phonetic.js";

/**
 * The vocabulary of one workspace: file and directory names, exported symbols,
 * package and script names, branches, and the terms the project's own docs
 * emphasize.
 *
 * Ranking is statistical, not editorial. A term's score is
 * `frequency × structural weight × inverse document frequency`, computed over
 * the workspace itself. Words that appear everywhere ("the", "pour", "index")
 * score near zero because their document frequency is high, and names that
 * identify one part of the project score high — without any word list.
 */

export type TermEntry = {
  /** Case-folded key. */
  key: string;
  /** Most frequent original spelling: what the voice should say and hear. */
  display: string;
  /** Final salience score. */
  score: number;
  /** Raw weighted count, before the IDF correction. */
  weight: number;
  /** How many distinct files or manifests mention it. */
  documentFrequency: number;
  phonetic: string[];
  sources: Set<TermSource>;
};

export type TermSource = "file" | "dir" | "symbol" | "package" | "branch" | "doc";

export type Lexicon = {
  directory: string;
  builtAt: number;
  /** Terms by key, ordered by descending score. */
  terms: Map<string, TermEntry>;
  branches: string[];
  fileCount: number;
  documentCount: number;
};

export type BuildOptions = {
  maxFiles: number;
  maxTerms: number;
  /** Source files opened for symbol extraction. */
  maxSourceFiles?: number;
  listFiles?: (dir: string, max: number) => Promise<string[]>;
  listBranches?: (dir: string) => Promise<string[]>;
  readText?: (path: string, maxBytes: number) => Promise<string | undefined>;
};

/** How much each provenance says "this is a name in this project". */
const SOURCE_WEIGHT: Record<TermSource, number> = {
  package: 5,
  file: 3,
  dir: 2.5,
  branch: 2,
  doc: 1.5,
  symbol: 1.2,
};

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "dist", "build", "target", ".next", ".turbo", "coverage", ".pnpm", ".mypy_cache", ".pytest_cache"]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".zsh", ".lua", ".vue", ".svelte"]);

const DOC_NAMES = new Set(["agents.md", "claude.md", "readme.md", "contributing.md", "context.md", "architecture.md"]);

/**
 * Declaration sites across the languages likely in a polyglot workspace.
 * These are syntax, not heuristics: each pattern matches a keyword the
 * language itself uses to introduce a name.
 */
const DECLARATIONS: RegExp[] = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)/gm,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\b(?:pub\s+)?(?:fn|struct|enum|trait|mod|impl)\s+([A-Za-z_]\w*)/g,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm,
  /^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm,
];

type Draft = {
  spellings: Map<string, number>;
  weight: number;
  documents: Set<string>;
  sources: Set<TermSource>;
};

export async function buildLexicon(directory: string, opts: BuildOptions): Promise<Lexicon> {
  const listFiles = opts.listFiles ?? defaultListFiles;
  const listBranches = opts.listBranches ?? defaultListBranches;
  const readText = opts.readText ?? defaultReadText;
  const drafts = new Map<string, Draft>();
  const documents = new Set<string>();

  const record = (spelling: string, source: TermSource, document: string, times = 1) => {
    const display = spelling.trim();
    if (display.length < 2 || display.length > 48) return;
    const key = display.toLocaleLowerCase();
    if (!/\p{L}/u.test(key)) return;
    let draft = drafts.get(key);
    if (!draft) {
      draft = { spellings: new Map(), weight: 0, documents: new Set(), sources: new Set() };
      drafts.set(key, draft);
    }
    draft.weight += SOURCE_WEIGHT[source] * times;
    draft.spellings.set(display, (draft.spellings.get(display) ?? 0) + times);
    draft.documents.add(document);
    draft.sources.add(source);
    documents.add(document);
  };

  const files = await listFiles(directory, opts.maxFiles);

  // Paths: the names the project gave to its own parts.
  const seenDirs = new Set<string>();
  for (const rel of files) {
    const base = basename(rel);
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    record(stem, "file", rel);
    for (const part of splitIdentifier(stem)) record(part, "file", rel);
    const segments = rel.split("/").slice(0, -1);
    for (const segment of segments) {
      if (EXCLUDED_DIRS.has(segment)) continue;
      const dirKey = `dir:${segment}`;
      if (!seenDirs.has(segment)) {
        seenDirs.add(segment);
        record(segment, "dir", dirKey);
        for (const part of splitIdentifier(segment)) record(part, "dir", dirKey);
      }
    }
  }

  // Declarations: what the code calls its own things.
  const sourceFiles = files.filter((f) => SOURCE_EXTS.has(extname(f).toLowerCase())).slice(0, opts.maxSourceFiles ?? 400);
  await forEachLimit(sourceFiles, 8, async (rel) => {
    const text = await readText(join(directory, rel), 400_000);
    if (!text) return;
    for (const pattern of DECLARATIONS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      let found = 0;
      while ((match = pattern.exec(text)) && found < 500) {
        found += 1;
        const symbol = match[1];
        if (!symbol || symbol.length < 2) continue;
        record(symbol, "symbol", rel);
        const parts = splitIdentifier(symbol);
        if (parts.length > 1) for (const part of parts) record(part, "symbol", rel);
      }
    }
  });

  // Manifests: package, script and dependency names.
  for (const manifest of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "composer.json", "deno.json"]) {
    const text = await readText(join(directory, manifest), 200_000);
    if (!text) continue;
    if (manifest.endsWith(".json")) {
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        if (typeof pkg.name === "string") record(unscope(pkg.name), "package", manifest, 2);
        for (const section of ["scripts", "dependencies", "devDependencies", "peerDependencies", "require"]) {
          const entry = pkg[section];
          if (entry && typeof entry === "object") for (const name of Object.keys(entry)) record(unscope(name), "package", manifest);
        }
      } catch {
        // A manifest we cannot parse contributes nothing.
      }
    } else {
      for (const m of text.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)) record(m[1], "package", manifest, 2);
      for (const m of text.matchAll(/^module\s+(?:\S+\/)?([\w.-]+)\s*$/gm)) record(m[1], "package", manifest, 2);
      for (const m of text.matchAll(/^\s*([A-Za-z][\w.-]+)\s*=\s*[{"^~>=]/gm)) record(m[1], "package", manifest);
    }
  }

  // Project docs: headings and inline code are the terms the team writes down.
  const docs = files.filter((f) => DOC_NAMES.has(basename(f).toLowerCase())).slice(0, 8);
  for (const rel of docs) {
    const text = await readText(join(directory, rel), 200_000);
    if (!text) continue;
    for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      for (const word of words(m[1])) record(word, "doc", rel);
    }
    for (const m of text.matchAll(/`([^`\n]{2,48})`/g)) {
      record(m[1], "doc", rel);
      for (const part of splitIdentifier(m[1])) record(part, "doc", rel);
    }
  }

  const branches = await listBranches(directory).catch(() => [] as string[]);
  for (const branch of branches) {
    record(branch, "branch", `branch:${branch}`);
    for (const part of splitIdentifier(branch)) record(part, "branch", `branch:${branch}`);
  }

  // Salience = weight × IDF. A term in half the documents is generic; a term
  // in one or two is a name. No vocabulary list is involved.
  const documentCount = Math.max(documents.size, 1);
  const scored: TermEntry[] = [];
  for (const [key, draft] of drafts) {
    const df = draft.documents.size;
    const idf = Math.log((documentCount + 1) / (df + 0.5));
    const score = draft.weight * Math.max(idf, 0.05);
    const display = pickSpelling(draft.spellings);
    scored.push({ key, display, score, weight: draft.weight, documentFrequency: df, phonetic: phoneticKeys(key), sources: draft.sources });
  }
  scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const terms = new Map<string, TermEntry>();
  for (const entry of scored.slice(0, opts.maxTerms)) terms.set(entry.key, entry);
  return { directory, builtAt: Date.now(), terms, branches, fileCount: files.length, documentCount };
}

/**
 * The spelling to show and to feed a recognizer. The most frequent one wins;
 * on a tie the form carrying case information wins, because that is how the
 * identifier is written in the code and how it should come back transcribed.
 */
function pickSpelling(spellings: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount) {
      best = spelling;
      bestCount = count;
      continue;
    }
    if (count !== bestCount) continue;
    const cased = spelling !== spelling.toLocaleLowerCase();
    const bestCased = best !== best.toLocaleLowerCase();
    if (cased && !bestCased) best = spelling;
    else if (cased === bestCased && spelling.localeCompare(best) < 0) best = spelling;
  }
  return best;
}

function unscope(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

async function defaultListFiles(dir: string, max: number): Promise<string[]> {
  const tracked = await execText("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], 5000).catch(() => undefined);
  if (tracked !== undefined) return tracked.split("\0").filter(Boolean).slice(0, max);
  const out: string[] = [];
  await walk(dir, dir, out, max);
  return out;
}

async function walk(root: string, dir: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= max) return;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(root, join(dir, entry.name), out, max);
    } else if (entry.isFile()) {
      out.push(relative(root, join(dir, entry.name)));
    }
  }
}

async function defaultListBranches(dir: string): Promise<string[]> {
  const text = await execText("git", ["-C", dir, "branch", "--format=%(refname:short)", "--sort=-committerdate"], 3000);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
}

async function defaultReadText(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function execText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  });
  await Promise.all(workers);
}
