import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, mergeConfig, shortLang } from "../../dist/daemon/config.js";
import { TtsEngine } from "../../dist/daemon/engines/tts.js";
import { normalizeLanguage } from "../../dist/daemon/engines/stt.js";
import { Logger } from "../../dist/daemon/log.js";

const log = new Logger({ level: "fatal" }).scope("test");

test("language tags collapse to the code the voices are keyed by", () => {
  assert.equal(shortLang("fr-FR"), "fr");
  assert.equal(shortLang("en_US"), "en");
  assert.equal(shortLang("FR"), "fr");
  assert.equal(shortLang("auto"), "auto");
  assert.equal(shortLang(""), "");
  assert.equal(shortLang(undefined), "");
});

test("whisper's language report is normalised whatever its shape", () => {
  assert.equal(normalizeLanguage("fr"), "fr");
  assert.equal(normalizeLanguage("fr-FR"), "fr");
  assert.equal(normalizeLanguage("french"), "fr");
  assert.equal(normalizeLanguage("English"), "en");
  assert.equal(normalizeLanguage(""), undefined);
  assert.equal(normalizeLanguage(undefined), undefined);
});

test("each language gets its own voice, with a fallback for the rest", () => {
  const cfg = mergeConfig(DEFAULTS, { tts: { url: "http://x/v1/audio/speech", voice: "fallback", voices: { fr: "ff_siwis", en: "af_heart" } } });
  const tts = new TtsEngine(cfg.tts, log);
  assert.equal(tts.voiceFor("fr"), "ff_siwis");
  assert.equal(tts.voiceFor("fr-FR"), "ff_siwis");
  assert.equal(tts.voiceFor("en"), "af_heart");
  assert.equal(tts.voiceFor("de"), "fallback");
  assert.equal(tts.voiceFor(undefined), "fallback");
});

test("the synthesis request carries the voice of the utterance's language", async () => {
  const cfg = mergeConfig(DEFAULTS, { tts: { url: "http://tts.local/v1/audio/speech", voices: { fr: "ff_siwis", en: "af_heart" } } });
  const seen = [];
  const fakeFetch = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
  };
  const tts = new TtsEngine(cfg.tts, log, fakeFetch);
  await tts.synthesize("Bonjour", { lang: "fr" });
  await tts.synthesize("Hello", { lang: "en" });
  assert.equal(seen[0].voice, "ff_siwis");
  assert.equal(seen[1].voice, "af_heart");
});

test("configured languages are normalised and the first one is the default", () => {
  const cfg = mergeConfig(DEFAULTS, {});
  assert.deepEqual(cfg.speech.languages, ["fr", "en"]);
  assert.equal(cfg.speech.default, "fr");
  assert.equal(cfg.stt.language, "auto", "whisper detects unless the user pins a language");
});
