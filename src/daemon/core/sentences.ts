import { marked, type Token, type Tokens } from "marked";
import { MAX_UTTERANCE_CHARS } from "../../shared/protocol.js";
import { isTerminated, sentences as icuSentences } from "../lexicon/tokenize.js";

/**
 * Turns a stream of markdown into a stream of speakable sentences.
 *
 * Markdown is parsed structurally with `marked`'s lexer rather than matched
 * with regexes, so a code block is a code block because the parser says so,
 * not because a line started with backticks. Sentence boundaries come from
 * ICU (`Intl.Segmenter`), which already knows that "etc." and "M. Dupont" are
 * not the end of a sentence in French.
 *
 * Incremental use: feed deltas as the model produces them. The splitter only
 * releases text it knows is final — a block whose structure can no longer
 * change, and a sentence ICU considers complete.
 */

export type SplitterOptions = {
  /** Spoken in place of a code block. */
  codeNotice?: string;
  /** Spoken in place of a table. */
  tableNotice?: string;
  locale?: string;
  /** Fragments below this length are merged with the next one. */
  minChars?: number;
  /** Utterances are cut at clause boundaries above this length. */
  maxChars?: number;
};

export type SplitStats = { spokenChars: number; codeChars: number; blocks: number };

export class SentenceSplitter {
  private buffer = "";
  /** Characters of `buffer` already released as speech. */
  private consumed = 0;
  private carry = "";
  private lastNoticeKey = "";
  readonly stats: SplitStats = { spokenChars: 0, codeChars: 0, blocks: 0 };
  private readonly opts: Required<SplitterOptions>;

  constructor(opts: SplitterOptions = {}) {
    this.opts = {
      codeNotice: opts.codeNotice ?? "Je te mets le code à l'écran.",
      tableNotice: opts.tableNotice ?? "Je t'affiche un tableau à l'écran.",
      locale: opts.locale ?? "fr",
      minChars: opts.minChars ?? 12,
      maxChars: opts.maxChars ?? MAX_UTTERANCE_CHARS,
    };
  }

  /** Feed a delta; returns whatever became safely speakable. */
  feed(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    return this.release(false);
  }

  /** Release everything that is left, including an unterminated last sentence. */
  flush(): string[] {
    const out = this.release(true);
    const tail = this.carry.trim();
    this.carry = "";
    if (tail) out.push(...this.chunk(tail));
    this.lastNoticeKey = "";
    for (const line of out) this.stats.spokenChars += line.length;
    return out;
  }

  private release(final: boolean): string[] {
    const out: string[] = [];
    const pending = this.buffer.slice(this.consumed);
    if (!pending.trim()) {
      if (final) this.consumed = this.buffer.length;
      return out;
    }
    let tokens: Token[];
    try {
      tokens = marked.lexer(pending) as Token[];
    } catch {
      // A malformed fragment is not a reason to go silent: speak it as text.
      if (final) {
        this.consumed = this.buffer.length;
        this.push(out, pending);
      }
      return out;
    }
    // While streaming, the last block may still grow (a fence not yet closed,
    // a list gaining items), so it is held back until the next delta.
    const stable = final ? tokens.length : tokens.length - 1;
    let advanced = 0;
    for (let i = 0; i < stable; i++) {
      const token = tokens[i];
      advanced += token.raw.length;
      this.speakToken(out, token, final || i < stable - 1);
    }
    this.consumed += advanced;
    if (!final) {
      // Inside a still-growing paragraph, complete sentences can already go out.
      const tail = tokens[tokens.length - 1];
      if (tail && (tail.type === "paragraph" || tail.type === "text")) {
        const spoken = this.eagerSentences(out, tail.raw);
        this.consumed += spoken;
      }
    } else {
      this.consumed = this.buffer.length;
    }
    for (const line of out) this.stats.spokenChars += line.length;
    return out;
  }

  /** Emit the complete sentences of a partial paragraph, keep the rest. */
  private eagerSentences(out: string[], raw: string): number {
    const parts = icuSentences(raw, this.opts.locale);
    if (parts.length <= 1 && !isTerminated(raw)) return 0;
    let consumed = 0;
    for (const part of parts) {
      if (!isTerminated(part)) break;
      const idx = raw.indexOf(part, consumed);
      if (idx < 0) break;
      consumed = idx + part.length;
      this.push(out, speakable(part));
    }
    // Only report what maps back to real characters of the buffer.
    return consumed;
  }

  private speakToken(out: string[], token: Token, closed: boolean) {
    switch (token.type) {
      case "code": {
        this.stats.codeChars += token.raw.length;
        this.stats.blocks += 1;
        this.notice(out, "code", this.opts.codeNotice);
        return;
      }
      case "table": {
        this.stats.blocks += 1;
        this.notice(out, "table", this.opts.tableNotice);
        return;
      }
      case "space":
      case "hr":
        return;
      case "list": {
        // Each item is a thought of its own, however short.
        for (const item of (token as Tokens.List).items) {
          this.emitText(out, item.text, closed, true);
        }
        return;
      }
      case "heading": {
        this.emitText(out, (token as Tokens.Heading).text, closed, true);
        return;
      }
      case "blockquote":
      case "paragraph":
      case "text": {
        this.emitText(out, (token as { text?: string; raw: string }).text ?? token.raw, closed);
        return;
      }
      case "html":
        return;
      default: {
        const text = (token as { text?: string }).text;
        if (text) this.emitText(out, text, closed);
      }
    }
  }

  /**
   * @param standalone A structural unit (heading, list item) that must not be
   *   glued to its neighbours even when it is short.
   */
  private emitText(out: string[], raw: string, closed: boolean, standalone = false) {
    const text = speakable(raw);
    if (!text) return;
    if (!closed && !standalone && !isTerminated(text)) {
      this.carry = (this.carry ? this.carry + " " : "") + text;
      return;
    }
    if (standalone) this.flushCarry(out);
    for (const sentence of icuSentences(text, this.opts.locale)) this.push(out, sentence, standalone);
  }

  /** A notice replaces a skipped block; repeats in a row are collapsed. */
  private notice(out: string[], key: string, text: string) {
    if (this.lastNoticeKey === key) return;
    this.lastNoticeKey = key;
    this.flushCarry(out);
    out.push(text);
  }

  private push(out: string[], text: string, standalone = false) {
    const clean = text.trim();
    if (!clean) return;
    this.lastNoticeKey = "";
    const merged = this.carry ? `${this.carry} ${clean}` : clean;
    if (!standalone && merged.length < this.opts.minChars) {
      this.carry = merged;
      return;
    }
    this.carry = "";
    out.push(...this.chunk(merged));
  }

  private flushCarry(out: string[]) {
    const tail = this.carry.trim();
    this.carry = "";
    if (tail) out.push(...this.chunk(tail));
  }

  /** Long sentences are split at clause boundaries so synthesis stays snappy. */
  private chunk(text: string): string[] {
    if (text.length <= this.opts.maxChars) return [text];
    const parts: string[] = [];
    let rest = text;
    while (rest.length > this.opts.maxChars) {
      const window = rest.slice(0, this.opts.maxChars);
      const clause = lastIndexOfAny(window, [", ", "; ", ": ", " — ", " – "]);
      const cut = clause > this.opts.minChars ? clause + 1 : window.lastIndexOf(" ");
      const at = cut > this.opts.minChars ? cut : this.opts.maxChars;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
    return parts.filter(Boolean);
  }
}

function lastIndexOfAny(text: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const idx = text.lastIndexOf(n);
    if (idx > best) best = idx;
  }
  return best;
}

/**
 * Inline markdown to spoken text. Inline constructs are resolved by the
 * lexer, so what remains is only what a voice should not read aloud:
 * a URL, and a path whose basename carries the meaning.
 */
export function speakable(raw: string): string {
  let text = raw;
  try {
    text = inlineToText(marked.lexer(raw) as Token[]);
  } catch {
    // fall through with the raw text
  }
  text = text.replace(/https?:\/\/\S+/g, "un lien");
  text = text.replace(/(?<![\w.])(?:~|\.{1,2})?(?:\/[\w@.+-]+)+\/?/g, (m) => basename(m));
  text = text.replace(/(?<![\w.])[\w@.+-]+(?:\/[\w@.+-]+)+/g, (m) => basename(m));
  return text.replace(/\s+/g, " ").trim();
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function inlineToText(tokens: Token[]): string {
  const out: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "code":
      case "table":
      case "html":
      case "space":
      case "hr":
        continue;
      case "list":
        out.push((token as Tokens.List).items.map((i) => i.text).join(". "));
        continue;
      case "image":
        continue;
      case "link":
        out.push((token as Tokens.Link).text);
        continue;
      default: {
        const withTokens = token as { tokens?: Token[]; text?: string; raw: string };
        if (withTokens.tokens?.length) out.push(inlineToText(withTokens.tokens));
        else out.push(withTokens.text ?? token.raw);
      }
    }
  }
  return out.join(" ");
}

/** Share of a finished answer that was code, measured on the parsed structure. */
export function codeRatio(text: string): number {
  if (!text) return 0;
  let code = 0;
  const walk = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "code" || token.type === "codespan") code += token.raw.length;
      const children = (token as { tokens?: Token[]; items?: Tokens.ListItem[] }).tokens;
      if (children?.length) walk(children);
      const items = (token as { items?: Tokens.ListItem[] }).items;
      if (items?.length) walk(items as unknown as Token[]);
    }
  };
  try {
    walk(marked.lexer(text) as Token[]);
  } catch {
    return 0;
  }
  return Math.min(1, code / text.length);
}
