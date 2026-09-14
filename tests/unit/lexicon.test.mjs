import test from "node:test";
import assert from "node:assert/strict";
import { buildLexicon } from "../../dist/daemon/lexicon/build.js";
import { candidatesFor, topPhrases } from "../../dist/daemon/lexicon/match.js";
import { phoneticKeys, similarity, soundsLike } from "../../dist/daemon/lexicon/phonetic.js";
import { splitIdentifier, words, ngrams, sentences } from "../../dist/daemon/lexicon/tokenize.js";

const FILES = [
  "src/daemon/core/orchestrator.ts",
  "src/daemon/core/streamer.ts",
  "src/daemon/transport/hub.ts",
  "src/browser/audio/mic.ts",
  "src/browser/audio/player.ts",
  "package.json",
  "README.md",
  "AGENTS.md",
];

const CONTENT = {
  "src/daemon/core/orchestrator.ts": "export class Orchestrator {}\nexport function renderBeat() {}\nconst pendingInject = 1;\n",
  "src/daemon/core/streamer.ts": "export class StreamerSession {}\nexport const beatTimeout = 2;\n",
  "src/daemon/transport/hub.ts": "export class Hub {}\n",
  "src/browser/audio/mic.ts": "export class Microphone {}\nexport function noiseFloor() {}\n",
  "src/browser/audio/player.ts": "export class VoicePlayer {}\n",
  "package.json": JSON.stringify({ name: "opencode-web-stream", scripts: { build: "x" }, dependencies: { talisman: "1", marked: "1" } }),
  "AGENTS.md": "# Orchestrator\nUse `streamer` and `hub` together.\n",
};

async function fixture() {
  return buildLexicon("/fake", {
    maxFiles: 100,
    maxTerms: 500,
    listFiles: async () => FILES,
    listBranches: async () => ["main", "claude/wizardly-noether"],
    readText: async (path) => CONTENT[path.replace("/fake/", "")],
  });
}

test("identifier splitting follows the language's own boundaries", () => {
  assert.deepEqual(splitIdentifier("streamerSessionID"), ["streamer", "Session", "ID"]);
  assert.deepEqual(splitIdentifier("opencode-web-stream"), ["opencode", "web", "stream"]);
  assert.deepEqual(splitIdentifier("HTTPServer"), ["HTTP", "Server"]);
  assert.deepEqual(splitIdentifier("beat_window_2"), ["beat", "window", "2"]);
});

test("word segmentation comes from ICU, not from a regex on spaces", () => {
  assert.deepEqual(words("Relance l'aujourd'hui, stp."), ["Relance", "l'aujourd'hui", "stp"]);
  assert.deepEqual(ngrams(["a", "b", "c"], 2), ["a", "a b", "b", "b c", "c"]);
});

test("sentence segmentation handles french abbreviations", () => {
  assert.deepEqual(sentences("Voir p. 3 du doc. Puis relancer."), ["Voir p. 3 du doc.", "Puis relancer."]);
});

test("phonetic keys span both french and english encoders", () => {
  const keys = phoneticKeys("streamer");
  assert.ok(keys.some((k) => k.startsWith("px:")), "expected a french key");
  assert.ok(keys.some((k) => k.startsWith("dm:")), "expected an english key");
});

test("french mis-transcriptions of english identifiers sound alike", () => {
  assert.ok(soundsLike("streamer", "strimeur") || similarity("streamer", "strimeur") > 0.7);
  assert.ok(similarity("hook", "houk") > 0.75);
  assert.ok(similarity("proxy", "proxi") > 0.8);
});

test("the lexicon ranks project names above words that are everywhere", () => {
  return fixture().then((lexicon) => {
    const rank = [...lexicon.terms.keys()];
    const position = (term) => rank.indexOf(term);
    assert.ok(lexicon.terms.has("orchestrator"));
    assert.ok(lexicon.terms.has("streamer"));
    // "src" appears in every path, so inverse document frequency sinks it.
    assert.ok(position("orchestrator") < position("src"), `orchestrator ${position("orchestrator")} vs src ${position("src")}`);
    assert.ok(position("streamer") < position("src"));
    assert.ok(lexicon.terms.get("src").score < lexicon.terms.get("hub").score);
  });
});

test("display spelling follows how the project actually writes the term", () => {
  return fixture().then((lexicon) => {
    // Written "Orchestrator" as a class and as a heading, "orchestrator" only as a path.
    assert.equal(lexicon.terms.get("orchestrator").display, "Orchestrator");
    // Written lowercase in the path and in the docs, capitalised only as a class.
    assert.equal(lexicon.terms.get("hub").display, "hub");
    // Uppercase file names survive.
    assert.equal(lexicon.terms.get("agents").display, "AGENTS");
  });
});

test("candidates surface the project term behind a mis-transcription", () => {
  return fixture().then((lexicon) => {
    const candidates = candidatesFor("relance le strimeur et l'orkestrator", lexicon, [], { limit: 6 });
    const terms = candidates.map((c) => c.term.toLowerCase());
    assert.ok(terms.includes("streamer"), `got ${terms.join(", ")}`);
    assert.ok(terms.includes("orchestrator"), `got ${terms.join(", ")}`);
  });
});

test("a term already spelled correctly produces no candidate for itself", () => {
  return fixture().then((lexicon) => {
    const candidates = candidatesFor("relance le streamer", lexicon, [], { limit: 6 });
    assert.ok(!candidates.some((c) => c.heard === "streamer" && c.term.toLowerCase() === "streamer"));
  });
});

test("learned aliases outrank phonetic guesses", () => {
  return fixture().then((lexicon) => {
    const aliases = [{ heard: "démon", canonical: "daemon", count: 3, updatedAt: Date.now() }];
    const candidates = candidatesFor("regarde le démon", lexicon, aliases, { limit: 4 });
    assert.equal(candidates[0].term, "daemon");
    assert.equal(candidates[0].via, "alias");
  });
});

test("recognizer phrases lead with learned aliases and stay bounded", () => {
  return fixture().then((lexicon) => {
    const aliases = [{ heard: "ouk", canonical: "hook", count: 1, updatedAt: Date.now() }];
    const phrases = topPhrases(lexicon, aliases, 10);
    assert.equal(phrases[0], "hook");
    assert.equal(phrases.length, 10);
    assert.equal(new Set(phrases).size, phrases.length);
  });
});

test("an empty workspace degrades to no candidates rather than throwing", () => {
  const candidates = candidatesFor("relance le strimeur", undefined, [], { limit: 5 });
  assert.deepEqual(candidates, []);
});
