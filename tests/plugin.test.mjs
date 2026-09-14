import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("opencode-web-stream plugin metadata and dist build", () => {
  const root = join(import.meta.dirname, "..");
  const manifestPath = join(root, "lens.plugin.json");
  const distPluginPath = join(root, "dist", "plugin.js");

  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(distPluginPath), true);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  assert.equal(manifest.name, "Live Stream");
  assert.equal(manifest.script, "./dist/plugin.js");

  const bundle = readFileSync(distPluginPath, "utf-8");
  // Check key markers: waves, dynamic ws, native composer integration, no overlay
  assert.equal(bundle.includes("opencode-web-stream-waves"), true);
  assert.equal(bundle.includes("getWsUrl"), true);
  assert.equal(bundle.includes("trajectory_redirect"), true);
  assert.equal(bundle.includes("agent_progress"), true);
  assert.equal(bundle.includes("barge_in"), true);
  // Check language synchronization & dynamic phonetic resolution features
  assert.equal(bundle.includes("resolveRecognitionLanguage"), true);
  assert.equal(bundle.includes("opencodeWebVoiceLang"), true);
  assert.equal(bundle.includes("resolvePhoneticText"), true);
  assert.equal(bundle.includes("/api/resolve"), true);
  // Phonetic resolve + learn stay available as metadata, but the UI never
  // injects clarification prompts and never appends over leftover composer text.
  assert.equal(bundle.includes("needs_clarification"), true);
  assert.equal(bundle.includes("sendLearnAlias"), true);
  assert.equal(bundle.includes("/api/learn"), true);
  assert.equal(bundle.includes("looksLikeClarificationEcho"), true);
  assert.equal(bundle.includes("scrubComposerClarificationResidue"), true);
  assert.equal(bundle.includes("Peux-tu me préciser"), false);
  assert.equal(bundle.includes("handleClarificationRequest"), false);
  assert.equal(bundle.includes("soundwave-clarification"), false);
  // Ensure overlay is completely removed
  assert.equal(bundle.includes("opencode-live-stream-overlay"), false);
});
