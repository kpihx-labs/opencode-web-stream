import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeLang,
  phrase,
  pickLang,
  supportedLangs,
  PHRASE_DEFAULT_LANG,
} from "../../dist/shared/phrases.js";

/**
 * The user-facing sentences live in src/shared/phrases.json, one block per
 * language. The code only imports and selects: adding a language means adding
 * a block, and this suite fails until every key exists in it.
 */

// Every key the code reads must exist in every covered language.
const REQUIRED_KEYS = ["cockpit.liveButton.noDir", "daemon.noDirectory", "daemon.liveRefused"];

test("tags resolve to covered languages with a safe fallback", () => {
  assert.equal(normalizeLang("fr-FR"), "fr");
  assert.equal(normalizeLang("en_US"), "en");
  assert.equal(normalizeLang("auto"), "");
  assert.equal(normalizeLang(undefined), "");
  assert.equal(pickLang("fr-FR"), "fr");
  assert.equal(pickLang("en-US"), "en");
  assert.equal(pickLang("de-DE"), PHRASE_DEFAULT_LANG);
  assert.equal(pickLang(undefined), PHRASE_DEFAULT_LANG);
});

test("every required phrase exists in every language", () => {
  assert.ok(supportedLangs().length >= 2);
  for (const lang of supportedLangs()) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(phrase(lang, key).length > 0, `${lang}.${key} is missing`);
    }
  }
});

test("unknown languages and keys degrade gracefully, never crash", () => {
  const fallback = phrase(PHRASE_DEFAULT_LANG, "daemon.noDirectory");
  assert.ok(fallback.length > 0);
  assert.equal(phrase("xx", "daemon.noDirectory"), fallback);
  assert.equal(phrase("fr", "no.such.key"), "");
});

test("no refusal sentence stays hardcoded in the sources", () => {
  // The bundled JSON legitimately carries the sentences as data; what must
  // not exist is a hardcoded literal in the code. So check the sources, and
  // check the build only for the key references.
  const ui = readFileSync(new URL("../../src/browser/ui.ts", import.meta.url), "utf8");
  const orch = readFileSync(new URL("../../src/daemon/core/orchestrator.ts", import.meta.url), "utf8");
  const hub = readFileSync(new URL("../../src/daemon/transport/hub.ts", import.meta.url), "utf8");
  for (const [name, code] of [["ui", ui], ["orchestrator", orch], ["hub", hub]]) {
    assert.doesNotMatch(code, /Je ne sais pas dans quel dossier/, `${name} still hardcodes the refusal`);
    assert.doesNotMatch(code, /aucun dossier détecté/, `${name} still hardcodes the tooltip`);
  }
  const daemon = readFileSync(new URL("../../dist/daemon/core/orchestrator.js", import.meta.url), "utf8");
  const hubBuilt = readFileSync(new URL("../../dist/daemon/transport/hub.js", import.meta.url), "utf8");
  const cockpit = readFileSync(new URL("../../dist/plugin.js", import.meta.url), "utf8");
  assert.match(daemon, /daemon\.noDirectory/);
  assert.match(hubBuilt, /daemon\.liveRefused/);
  assert.match(cockpit, /cockpit\.liveButton\.noDir/);
});
