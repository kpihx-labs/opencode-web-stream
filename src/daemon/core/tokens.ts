/**
 * Streamer output grammar.
 *
 *   <quiet/>
 *   <say>…</say>
 *   <reply>…</reply>
 *   <clarify>…</clarify>
 *   <inject mode="queue|interrupt">…</inject>
 *   <permission answer="once|always|reject"/>
 *   <question answers='[["A"],["B","C"]]'/>
 *   <control action="mute|unmute|stop|repeat|slower|faster|digest|full"/>
 *   <learn heard="…" canonical="…"/>
 *
 * The parser is tolerant: attribute quoting may be single or double, tags may
 * be upper or lower case, and text outside any tag is either spoken or dropped
 * depending on `untagged`. Speakable tags (say, reply, clarify) can also be
 * read incrementally while the model is still streaming.
 */

import type { ControlAction } from "../../shared/protocol.js";
import type { PermissionReply } from "../../shared/opencode-events.js";

export type Decision =
  | { kind: "quiet" }
  | { kind: "say"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "inject"; mode: "queue" | "interrupt"; text: string }
  | { kind: "permission"; answer: PermissionReply }
  | { kind: "question"; answers: string[][] }
  | { kind: "control"; action: ControlAction }
  | { kind: "learn"; heard: string; canonical: string };

export const SPEAKABLE_TAGS = new Set(["say", "reply", "clarify"]);

const CONTROL_ACTIONS = new Set<ControlAction>(["mute", "unmute", "stop", "repeat", "slower", "faster", "digest", "full"]);
const PERMISSION_ANSWERS = new Set<PermissionReply>(["once", "always", "reject"]);

const TAG_RE = /<\s*(\/?)\s*([a-zA-Z]+)((?:\s+[a-zA-Z_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)\s*>/g;

export function parseAttributes(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

export function parseStreamerOutput(text: string, opts: { untagged?: "say" | "quiet" } = {}): Decision[] {
  const decisions: Decision[] = [];
  const src = text ?? "";
  let cursor = 0;
  let sawTag = false;
  const untaggedParts: string[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src))) {
    const [full, closing, rawName, attrSrc, selfClose] = m;
    const name = rawName.toLowerCase();
    const known = SPEAKABLE_TAGS.has(name) || ["quiet", "inject", "permission", "question", "control", "learn"].includes(name);
    if (!known) continue;
    sawTag = true;
    if (m.index > cursor) untaggedParts.push(src.slice(cursor, m.index));
    if (closing) {
      cursor = m.index + full.length;
      continue;
    }
    const attrs = parseAttributes(attrSrc);
    if (selfClose || name === "quiet" || ["permission", "question", "control", "learn"].includes(name)) {
      cursor = m.index + full.length;
      const d = selfClosing(name, attrs);
      if (d) decisions.push(d);
      continue;
    }
    // Container tag: find its close (or the next tag, or end of text).
    const closeRe = new RegExp(`<\\s*/\\s*${name}\\s*>`, "i");
    const after = src.slice(m.index + full.length);
    const closeIdx = after.search(closeRe);
    let body: string;
    if (closeIdx >= 0) {
      body = after.slice(0, closeIdx);
      const closeLen = after.match(closeRe)![0].length;
      cursor = m.index + full.length + closeIdx + closeLen;
    } else {
      const next = after.search(/<\s*[a-zA-Z]+[^>]*>/);
      body = next >= 0 ? after.slice(0, next) : after;
      cursor = m.index + full.length + body.length;
    }
    TAG_RE.lastIndex = cursor;
    const inner = body.trim();
    if (!inner) continue;
    if (name === "inject") {
      const mode = attrs.mode === "interrupt" ? "interrupt" : "queue";
      decisions.push({ kind: "inject", mode, text: inner });
    } else if (name === "say") decisions.push({ kind: "say", text: inner });
    else if (name === "reply") decisions.push({ kind: "reply", text: inner });
    else if (name === "clarify") decisions.push({ kind: "clarify", text: inner });
  }
  if (cursor < src.length) untaggedParts.push(src.slice(cursor));
  const untagged = untaggedParts.join(" ").replace(/\s+/g, " ").trim();
  if (!sawTag) {
    if (untagged && opts.untagged === "say") return [{ kind: "say", text: untagged }];
    return [{ kind: "quiet" }];
  }
  if (decisions.length === 0) return [{ kind: "quiet" }];
  return decisions;
}

function selfClosing(name: string, attrs: Record<string, string>): Decision | undefined {
  switch (name) {
    case "quiet":
      return { kind: "quiet" };
    case "permission": {
      const answer = (attrs.answer ?? attrs.reply ?? "").toLowerCase() as PermissionReply;
      return PERMISSION_ANSWERS.has(answer) ? { kind: "permission", answer } : undefined;
    }
    case "question": {
      const raw = attrs.answers ?? attrs.answer ?? "";
      const answers = parseAnswers(raw);
      return answers.length ? { kind: "question", answers } : undefined;
    }
    case "control": {
      const action = (attrs.action ?? "").toLowerCase() as ControlAction;
      return CONTROL_ACTIONS.has(action) ? { kind: "control", action } : undefined;
    }
    case "learn": {
      const heard = attrs.heard ?? "";
      const canonical = attrs.canonical ?? attrs.term ?? "";
      return heard && canonical && heard.toLowerCase() !== canonical.toLowerCase()
        ? { kind: "learn", heard, canonical }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Accept JSON (`[["A"]]`), a flat list (`["A","B"]`), or plain text (`A | B`). */
export function parseAnswers(raw: string): string[][] {
  const s = raw.trim();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    if (Array.isArray(parsed)) {
      if (parsed.every((x) => typeof x === "string")) return [parsed as string[]];
      if (parsed.every((x) => Array.isArray(x))) return (parsed as unknown[][]).map((a) => a.map(String));
    }
    if (typeof parsed === "string") return [[parsed]];
  } catch {
    // plain text
  }
  return [s.split(/\s*[|;]\s*/).filter(Boolean)];
}

/**
 * Reads speakable text out of a streaming model output as it arrives.
 * `feed(delta)` returns the newly available speakable characters; the
 * daemon pipes them through a SentenceSplitter so TTS can start before the
 * model has finished.
 */
export class IncrementalSpeechReader {
  private pending = "";
  private inTag: string | undefined;
  private done = false;

  feed(delta: string): string {
    if (this.done || !delta) return "";
    this.pending += delta;
    let out = "";
    while (this.pending.length) {
      if (this.inTag) {
        const close = this.pending.search(new RegExp(`<\\s*/\\s*${this.inTag}\\s*>`, "i"));
        const anyLt = this.pending.indexOf("<");
        if (close >= 0) {
          out += this.pending.slice(0, close);
          const closeLen = this.pending.slice(close).match(/<\s*\/\s*[a-zA-Z]+\s*>/)![0].length;
          this.pending = this.pending.slice(close + closeLen);
          this.inTag = undefined;
          continue;
        }
        if (anyLt >= 0) {
          // Might be the start of the closing tag: emit up to it and wait.
          out += this.pending.slice(0, anyLt);
          this.pending = this.pending.slice(anyLt);
          if (this.pending.length > 24 && !/^<\s*\/?\s*[a-zA-Z]*\s*>?$/.test(this.pending.slice(0, 24))) {
            // Not a tag after all (e.g. "a < b"): emit the '<' too.
            out += this.pending[0];
            this.pending = this.pending.slice(1);
            continue;
          }
          break;
        }
        out += this.pending;
        this.pending = "";
        break;
      }
      const lt = this.pending.indexOf("<");
      if (lt < 0) {
        this.pending = "";
        break;
      }
      const gt = this.pending.indexOf(">", lt);
      if (gt < 0) {
        this.pending = this.pending.slice(lt);
        break;
      }
      const tag = this.pending.slice(lt, gt + 1);
      this.pending = this.pending.slice(gt + 1);
      const m = tag.match(/^<\s*(\/?)\s*([a-zA-Z]+)[^>]*?(\/?)\s*>$/);
      if (!m) continue;
      const [, closing, rawName, selfClose] = m;
      const name = rawName.toLowerCase();
      if (!closing && !selfClose && SPEAKABLE_TAGS.has(name)) this.inTag = name;
    }
    return out;
  }

  finish(): string {
    this.done = true;
    if (this.inTag) {
      const rest = this.pending.replace(/<[^>]*$/, "");
      this.pending = "";
      this.inTag = undefined;
      return rest;
    }
    this.pending = "";
    return "";
  }
}
