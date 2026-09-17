import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPEECH_PRIORITY, PROTOCOL_VERSION, MAX_UTTERANCE_CHARS } from "../../dist/shared/protocol.js";

/**
 * The cockpit bundle cannot be imported under Node (it touches `window` at
 * load time), so its pure logic is exercised by extracting the functions from
 * the built bundle, and its wiring by asserting on the bundle's contents. That
 * keeps the browser half covered without pulling in a headless browser.
 */

const bundle = readFileSync(new URL("../../dist/plugin.js", import.meta.url), "utf8");

/** Rebuild one exported function from the bundle, standalone. */
function extract(name, deps = "") {
  const start = bundle.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in the bundle`);
  let depth = 0;
  let i = bundle.indexOf("{", start);
  const open = i;
  for (; i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = bundle.slice(start, i + 1);
  return new Function(`${deps}\n${body}\nreturn ${name};`)();
}

test("speech priority orders blocking events above narration", () => {
  assert.ok(SPEECH_PRIORITY.blocked > SPEECH_PRIORITY.reply);
  assert.ok(SPEECH_PRIORITY.reply > SPEECH_PRIORITY.answer);
  assert.ok(SPEECH_PRIORITY.answer > SPEECH_PRIORITY.beat);
  assert.ok(SPEECH_PRIORITY.system > SPEECH_PRIORITY.answer);
});

test("the protocol is versioned so a stale cockpit is detectable", () => {
  assert.equal(typeof PROTOCOL_VERSION, "number");
  assert.ok(PROTOCOL_VERSION >= 1);
  assert.ok(MAX_UTTERANCE_CHARS > 100);
});

test("synthesis chunking keeps every piece under the browser's cutoff", () => {
  const chunkForSynthesis = extract("chunkForSynthesis");
  const short = "Je relance les tests.";
  assert.deepEqual(chunkForSynthesis(short), [short]);

  const long = "Je relance les tests unitaires, puis les tests d'intégration, puis le lint, puis je regarde le rapport de couverture, et enfin je pousse la branche.";
  const parts = chunkForSynthesis(long, 60);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 62, `too long: ${part}`);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
});

test("what the listener heard is cut at a word boundary", () => {
  const approximateHeard = extract("approximateHeard");
  const text = "Je remonte la trace du timeout dans le proxy";
  assert.equal(approximateHeard(text, 1), text);
  assert.equal(approximateHeard(text, 0), "");
  const partial = approximateHeard(text, 0.5);
  assert.ok(text.startsWith(partial));
  assert.ok(!partial.endsWith(" "));
  assert.ok(text.slice(partial.length).startsWith(" ") || partial.length === 0);
});

test("the noise floor tracks the room rather than a fixed threshold", () => {
  const noiseFloor = extract("noiseFloor");
  // Too little history: assume a quiet room rather than deafness.
  assert.equal(noiseFloor([-50, -48]), -55);

  const quietRoom = Array.from({ length: 60 }, () => -62 + Math.random());
  const noisyRoom = Array.from({ length: 60 }, () => -34 + Math.random());
  assert.ok(noiseFloor(quietRoom) < -60);
  assert.ok(noiseFloor(noisyRoom) > -36);

  // Speech in the window must not drag the floor up with it.
  const withSpeech = [...Array.from({ length: 50 }, () => -60), ...Array.from({ length: 20 }, () => -20)];
  assert.ok(noiseFloor(withSpeech) < -55);
});

test("the session id is read from both opencode web route shapes", () => {
  const sessionIdFromLocation = extract("sessionIdFromLocation");
  assert.equal(sessionIdFromLocation("/session/ses_abc123"), "ses_abc123");
  assert.equal(sessionIdFromLocation("/L2hvbWUva3BpaHg=/session/ses_abc123"), "ses_abc123");
  assert.equal(sessionIdFromLocation("/server/local/session/ses_x?tab=diff"), "ses_x");
  assert.equal(sessionIdFromLocation("/new-session"), "");
});

test("the bundle wires the duplex loop it claims to", () => {
  // Barge-in is local and immediate; the interpretation is not.
  assert.match(bundle, /onSpeechConfirmed/);
  assert.match(bundle, /barge_in_false/);
  // Echo cancellation through a loopback peer connection.
  assert.match(bundle, /RTCPeerConnection/);
  assert.match(bundle, /echoCancellation/);
  // Both transcription paths exist.
  assert.match(bundle, /webkitSpeechRecognition/);
  assert.match(bundle, /\/api\/stt/);
  // Contextual biasing where the browser supports it.
  assert.match(bundle, /SpeechRecognitionPhrase/);
  assert.match(bundle, /processLocally/);
  // Server voice with a browser fallback.
  assert.match(bundle, /\/api\/tts/);
  assert.match(bundle, /speechSynthesis/);
  // Same-origin only, so Lens and Tailscale work unchanged.
  assert.match(bundle, /__stream__/);
  assert.match(bundle, /\/ws\/stream/);
  assert.doesNotMatch(bundle, /127\.0\.0\.1:8765/);
});

test("language is one switch shared with the voice plugin, fr and en first", () => {
  // Reads and writes the opencode-web-voice plugin's key and selector.
  assert.match(bundle, /opencodeWebVoiceLang/);
  assert.match(bundle, /opencode-web-voice-plugin-lang-select/);
  // Region comes from ICU likely subtags, not from a table.
  assert.match(bundle, /Intl\.Locale/);
  // The voice follows the utterance's language, server side and browser side.
  assert.match(bundle, /item\.utterance\.lang/);
  const localeFor = extract("localeFor");
  assert.equal(localeFor("fr"), "fr-FR");
  assert.equal(localeFor("en"), "en-US");
  assert.equal(localeFor(undefined), undefined);
  const regionalize = extract("regionalize");
  assert.equal(regionalize("fr"), "fr-FR");
  assert.equal(regionalize("en-GB"), "en-GB");
});

test("the bundle carries no leftover heuristics", () => {
  // No tool classification, no confidence gate, no clarification templates.
  assert.doesNotMatch(bundle, /SILENT_TOOLS|CATEGORY_MAP/);
  assert.doesNotMatch(bundle, /needs_clarification/);
  assert.doesNotMatch(bundle, /Peux-tu me préciser/);
});

test("the draft store reveals the folder on a new-session page", () => {
  const directoryFromDraft = extract("directoryFromDraft", 'const TABS_KEY="opencode.window.browser.dat:tabs";');
  const tabs = JSON.stringify([
    { type: "draft", draftID: "ea3bf1d2", server: "https://x", directory: "/home/kpihx/KpihX-Labs/Explore" },
    { type: "draft", draftID: "other", server: "https://x", directory: "/tmp" },
  ]);
  globalThis.location = { search: "?draftId=ea3bf1d2" };
  globalThis.localStorage = { getItem: (key) => (key === "opencode.window.browser.dat:tabs" ? tabs : null) };
  try {
    assert.equal(directoryFromDraft(), "/home/kpihx/KpihX-Labs/Explore");
    globalThis.location = { search: "?draftId=missing" };
    assert.equal(directoryFromDraft(), "");
    globalThis.location = { search: "" };
    assert.equal(directoryFromDraft(), "");
    globalThis.localStorage = { getItem: () => null };
    globalThis.location = { search: "?draftId=ea3bf1d2" };
    assert.equal(directoryFromDraft(), "");
  } finally {
    delete globalThis.location;
    delete globalThis.localStorage;
  }
});
