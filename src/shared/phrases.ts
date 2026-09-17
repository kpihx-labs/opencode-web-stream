/**
 * Quick-info phrases, one copy per language. The code never hardcodes a
 * user-facing sentence: it imports this file and selects by language.
 *
 * Layout: `languages.<code>.<side>.<area>.<key>`.
 * - `<code>` is a two-letter language ("fr", "en"). Add a whole block to add
 *   a language; the unit test fails until every key exists in it, so nothing
 *   ships half-translated.
 * - `<side>` is where the text surfaces: `cockpit` (browser UI) or `daemon`
 *   (spoken or reported by the server side).
 * - `<area>` groups one screen or flow (`liveButton`), `<key>` one sentence.
 */
import data from "./phrases.json" with { type: "json" };

type PhraseTree = { [key: string]: string | PhraseTree };

const LANGUAGES = (data as { languages: Record<string, PhraseTree> }).languages;

export const PHRASE_VERSION = (data as { version: number }).version;
export const PHRASE_DEFAULT_LANG = (data as { defaultLang: string }).defaultLang;

/** Languages this file actually covers. */
export function supportedLangs(): string[] {
  return Object.keys(LANGUAGES);
}

function treeFor(lang: string): PhraseTree {
  return LANGUAGES[lang] ?? LANGUAGES[PHRASE_DEFAULT_LANG] ?? {};
}

/** "fr-FR" -> "fr". "auto", empty or garbage -> "". */
export function normalizeLang(tag: string | undefined): string {
  if (!tag) return "";
  const trimmed = tag.trim().toLowerCase();
  if (!trimmed || trimmed === "auto") return "";
  return trimmed.split(/[-_]/)[0].slice(0, 3);
}

/**
 * Best covered language for a tag, else `fallback` (usually the configured
 * default). Both sides call this: the cockpit with the selector value, the
 * daemon with the message language.
 */
export function pickLang(tag: string | undefined, fallback: string = PHRASE_DEFAULT_LANG): string {
  const code = normalizeLang(tag);
  if (code && LANGUAGES[code]) return code;
  if (LANGUAGES[fallback]) return fallback;
  return PHRASE_DEFAULT_LANG;
}

/**
 * Dotted-path lookup ("cockpit.liveButton.noDir"): the requested language
 * first, the default language second, "" when the key exists nowhere (logged
 * by the caller, never thrown).
 */
export function phrase(lang: string, path: string): string {
  const get = (tree: PhraseTree): string | undefined => {
    let node: string | PhraseTree | undefined = tree;
    for (const part of path.split(".")) {
      if (!node || typeof node !== "object") return undefined;
      node = node[part];
    }
    return typeof node === "string" ? node : undefined;
  };
  return get(treeFor(lang)) ?? get(treeFor(PHRASE_DEFAULT_LANG)) ?? "";
}
