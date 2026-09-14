import doubleMetaphone from "talisman/phonetics/double-metaphone.js";
import metaphone from "talisman/phonetics/metaphone.js";
import phonex from "talisman/phonetics/french/phonex.js";
import sonnex from "talisman/phonetics/french/sonnex.js";
import fonem from "talisman/phonetics/french/fonem.js";
import jaroWinklerSimilarity from "talisman/metrics/jaro-winkler.js";
import levenshteinDistance from "talisman/metrics/levenshtein.js";

/**
 * Phonetic encoding and string similarity, delegated to talisman's reference
 * implementations.
 *
 * Speech here is bilingual: French sentences carrying English identifiers,
 * pronounced with a French accent. A single encoder cannot span that, so every
 * term is encoded with both families and matched on either:
 *
 * - French: Phonex, Sonnex and FONEM, all designed for French orthography.
 * - English: Double Metaphone (both codes) and Metaphone.
 *
 * Similarity uses Jaro-Winkler (good on short tokens with a shared prefix,
 * which identifiers usually are) with a Levenshtein ratio as a second opinion.
 */

export function stripAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Letters only, lowercase, accents folded: what the encoders expect. */
export function phoneticInput(word: string): string {
  return stripAccents(word)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Phonetic signatures of a word, namespaced by encoder so two different
 * encoders cannot collide on the same string.
 */
export function phoneticKeys(word: string): string[] {
  const input = phoneticInput(word);
  if (input.length < 2) return [];
  const keys = new Set<string>();
  const add = (prefix: string, value: unknown) => {
    if (typeof value === "string" && value.length) keys.add(`${prefix}:${value}`);
  };
  try {
    add("px", phonex(input));
    add("sx", sonnex(input));
    add("fo", fonem(input));
    const [primary, secondary] = doubleMetaphone(input);
    add("dm", primary);
    if (secondary && secondary !== primary) add("dm", secondary);
    add("mp", metaphone(input));
  } catch {
    // A term the encoders reject (all digits, say) simply has no phonetic key.
  }
  return [...keys];
}

/** Similarity in [0, 1]: Jaro-Winkler, backed by a Levenshtein ratio. */
export function similarity(a: string, b: string): number {
  const x = phoneticInput(a);
  const y = phoneticInput(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const jw = jaroWinklerSimilarity(x, y);
  const lev = 1 - levenshteinDistance(x, y) / Math.max(x.length, y.length);
  return Math.max(jw, lev);
}

/** Do two words share at least one phonetic signature? */
export function soundsLike(a: string, b: string): boolean {
  const ka = phoneticKeys(a);
  if (!ka.length) return false;
  const kb = new Set(phoneticKeys(b));
  return ka.some((k) => kb.has(k));
}

export function normalizeForMatch(text: string): string {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
