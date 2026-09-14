import test from "node:test";
import assert from "node:assert/strict";
import { parseStreamerOutput, parseAnswers, IncrementalSpeechReader } from "../../dist/daemon/core/tokens.js";

test("quiet is the default when nothing is tagged on a beat", () => {
  assert.deepEqual(parseStreamerOutput("", { untagged: "quiet" }), [{ kind: "quiet" }]);
  assert.deepEqual(parseStreamerOutput("<quiet/>"), [{ kind: "quiet" }]);
  assert.deepEqual(parseStreamerOutput("Je crois que rien", { untagged: "quiet" }), [{ kind: "quiet" }]);
});

test("untagged prose becomes speech where that is the configured fallback", () => {
  assert.deepEqual(parseStreamerOutput("Je patche le proxy.", { untagged: "say" }), [{ kind: "say", text: "Je patche le proxy." }]);
});

test("say, reply and clarify carry their text", () => {
  assert.deepEqual(parseStreamerOutput("<say>Je relance les tests.</say>"), [{ kind: "say", text: "Je relance les tests." }]);
  assert.deepEqual(parseStreamerOutput("<reply>On en est à la moitié.</reply>"), [{ kind: "reply", text: "On en est à la moitié." }]);
  assert.deepEqual(parseStreamerOutput("<clarify>Le fichier du proxy ou du démon ?</clarify>"), [
    { kind: "clarify", text: "Le fichier du proxy ou du démon ?" },
  ]);
});

test("inject defaults to queue and reads its mode", () => {
  assert.deepEqual(parseStreamerOutput("<inject>ajoute un test</inject>"), [{ kind: "inject", mode: "queue", text: "ajoute un test" }]);
  assert.deepEqual(parseStreamerOutput(`<inject mode='interrupt'>stop, refais</inject>`), [
    { kind: "inject", mode: "interrupt", text: "stop, refais" },
  ]);
});

test("inject followed by say yields both decisions in order", () => {
  const decisions = parseStreamerOutput("<inject mode=\"queue\">ajoute un test</inject>\n<say>Je note ça pour la suite.</say>");
  assert.deepEqual(decisions, [
    { kind: "inject", mode: "queue", text: "ajoute un test" },
    { kind: "say", text: "Je note ça pour la suite." },
  ]);
});

test("permission and question answers are validated", () => {
  assert.deepEqual(parseStreamerOutput('<permission answer="once"/>'), [{ kind: "permission", answer: "once" }]);
  assert.deepEqual(parseStreamerOutput('<permission answer="maybe"/>'), [{ kind: "quiet" }]);
  assert.deepEqual(parseStreamerOutput(`<question answers='[["Oui"]]'/>`), [{ kind: "question", answers: [["Oui"]] }]);
});

test("answers accept json, flat lists and plain text", () => {
  assert.deepEqual(parseAnswers('[["A"],["B","C"]]'), [["A"], ["B", "C"]]);
  assert.deepEqual(parseAnswers('["A","B"]'), [["A", "B"]]);
  assert.deepEqual(parseAnswers("Option A | Option B"), [["Option A", "Option B"]]);
});

test("control actions are constrained to the known set", () => {
  assert.deepEqual(parseStreamerOutput('<control action="mute"/>'), [{ kind: "control", action: "mute" }]);
  assert.deepEqual(parseStreamerOutput('<control action="selfdestruct"/>'), [{ kind: "quiet" }]);
});

test("learn requires both sides and a real difference", () => {
  assert.deepEqual(parseStreamerOutput('<learn heard="ouk" canonical="hook"/>'), [{ kind: "learn", heard: "ouk", canonical: "hook" }]);
  assert.deepEqual(parseStreamerOutput('<learn heard="hook" canonical="hook"/>'), [{ kind: "quiet" }]);
});

test("case and stray prose do not break the parser", () => {
  const decisions = parseStreamerOutput("Bon. <SAY>Je regarde le proxy.</SAY> voilà");
  assert.deepEqual(decisions, [{ kind: "say", text: "Je regarde le proxy." }]);
});

test("an unclosed speakable tag still yields its text", () => {
  assert.deepEqual(parseStreamerOutput("<say>Je regarde le proxy."), [{ kind: "say", text: "Je regarde le proxy." }]);
});

test("incremental reader releases only speakable text", () => {
  const reader = new IncrementalSpeechReader();
  let out = "";
  out += reader.feed("<say>Je relance ");
  out += reader.feed("les tests.</say>");
  out += reader.feed("<learn heard=\"ouk\" canonical=\"hook\"/>");
  out += reader.finish();
  assert.equal(out.trim(), "Je relance les tests.");
});

test("incremental reader ignores non-speakable blocks entirely", () => {
  const reader = new IncrementalSpeechReader();
  let out = "";
  for (const chunk of ["<inject mode=\"queue\">", "ajoute un test", "</inject>", "<say>C'est noté.</say>"]) out += reader.feed(chunk);
  out += reader.finish();
  assert.equal(out.trim(), "C'est noté.");
});
