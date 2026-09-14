import test from "node:test";
import assert from "node:assert/strict";
import { SentenceSplitter, codeRatio, speakable } from "../../dist/daemon/core/sentences.js";

const NOTICES = { codeNotice: "CODE", tableNotice: "TABLE" };

function feedAll(splitter, chunks) {
  const out = [];
  for (const chunk of chunks) out.push(...splitter.feed(chunk));
  out.push(...splitter.flush());
  return out;
}

test("a streamed paragraph is released sentence by sentence", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const early = splitter.feed("Je lis la config du proxy. Elle a l'air ");
  assert.deepEqual(early, ["Je lis la config du proxy."]);
  const rest = [...splitter.feed("bonne, je vais voir le démon."), ...splitter.flush()];
  assert.deepEqual(rest, ["Elle a l'air bonne, je vais voir le démon."]);
});

test("french abbreviations are not sentence boundaries", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Les fichiers, etc. sont en place. Fin."]);
  assert.equal(out.length, 2);
  assert.match(out[0], /etc\. sont en place\.$/);
});

test("a code block becomes one spoken notice", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Voici le patch.\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nC'est appliqué."]);
  assert.deepEqual(out, ["Voici le patch.", "CODE", "C'est appliqué."]);
  assert.ok(splitter.stats.codeChars > 0);
});

test("a table becomes one notice, not a reading of its cells", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Résultats.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nVoilà."]);
  assert.deepEqual(out, ["Résultats.", "TABLE", "Voilà."]);
});

test("markdown emphasis and links are read as plain words", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Le **proxy** est `up`, voir [la doc](http://x.y/z)."]);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Le proxy est up/);
  assert.doesNotMatch(out[0], /\*\*|`|http/);
});

test("paths are spoken by their file name", () => {
  assert.equal(speakable("Je patche src/daemon/core/beats.ts maintenant."), "Je patche beats.ts maintenant.");
  assert.equal(speakable("Voir ~/.config/opencode/agents/streamer.md"), "Voir streamer.md");
});

test("headings and list items become their own utterances", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["## Résultat\n\n- le proxy répond\n- le démon répond\n"]);
  assert.deepEqual(out, ["Résultat", "le proxy répond", "le démon répond"]);
});

test("a long sentence is cut at clause boundaries", () => {
  const splitter = new SentenceSplitter({ ...NOTICES, maxChars: 60 });
  const text = "Je relance les tests unitaires, puis les tests d'intégration, puis je vérifie le lint avant de pousser.";
  const out = feedAll(splitter, [text]);
  assert.ok(out.length > 1);
  for (const part of out) assert.ok(part.length <= 62, `too long: ${part}`);
  assert.equal(out.join(" ").replace(/\s+/g, " "), text);
});

test("very short fragments are merged rather than spoken alone", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Ok. ", "Je relance la suite complète."]);
  assert.equal(out.length, 1);
  assert.equal(out[0], "Ok. Je relance la suite complète.");
});

test("delta boundaries in the middle of words do not split words", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Je pa", "tche le pro", "xy maintenant. Fini."]);
  assert.deepEqual(out, ["Je patche le proxy maintenant.", "Fini."]);
});

test("code ratio measures parsed structure, not backtick counting", () => {
  assert.equal(codeRatio("Pas de code ici du tout."), 0);
  assert.ok(codeRatio("Voici.\n\n```js\n" + "x".repeat(400) + "\n```\n") > 0.5);
});

test("an unterminated stream is still fully flushed", () => {
  const splitter = new SentenceSplitter(NOTICES);
  const out = feedAll(splitter, ["Je regarde le proxy et ça continue sans point final"]);
  assert.deepEqual(out, ["Je regarde le proxy et ça continue sans point final"]);
});
