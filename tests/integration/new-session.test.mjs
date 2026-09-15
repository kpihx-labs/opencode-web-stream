import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FakeOpencode, until } from "../helpers/fake-opencode.mjs";
import { startDaemon } from "../../dist/daemon/index.js";
import { DEFAULTS } from "../../dist/daemon/config.js";
import { Logger } from "../../dist/daemon/log.js";
import { sessionUrl } from "../../dist/daemon/core/orchestrator.js";

/**
 * Speaking on the new-session page has to work, and has to be visible.
 *
 * The first build assumed a session already existed and called the REST API
 * with an empty id, which returned the app's HTML and crashed the injection.
 * The user was left on a blank page while the agent worked out of sight. The
 * session is now created on the first spoken word and the cockpit is moved
 * onto it, which is what typing and pressing enter does.
 */

const DIRECTORY = "/home/kpihx/project";

async function harness() {
  const opencode = new FakeOpencode();
  const url = await opencode.listen();
  const dataDir = mkdtempSync(join(tmpdir(), "ows-new-"));
  const cfg = {
    ...structuredClone(DEFAULTS),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "error",
    opencode: { ...DEFAULTS.opencode, url },
    stt: { ...DEFAULTS.stt, url: "" },
    tts: { ...DEFAULTS.tts, url: "" },
    streamer: { ...DEFAULTS.streamer, injectDelayMs: 20, blockedRepeatMs: 0 },
    beats: { ...DEFAULTS.beats, windowMs: 60 },
  };
  const daemon = await startDaemon(cfg, { logger: new Logger({ level: "error" }) });
  await opencode.waitForSubscriber();
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/stream`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  return {
    opencode,
    daemon,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    of: (type) => messages.filter((m) => m.type === type),
    async cleanup() {
      ws.close();
      await daemon.stop();
      await opencode.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("live on the new-session page arms without touching the server", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.send({ type: "live", sessionID: "", enabled: true, directory: DIRECTORY });
  await until(() => h.of("state").length > 0, { label: "state" });

  assert.equal(h.of("state")[0].state, "listening");
  assert.equal(h.of("error").length, 0, "an empty session is normal here, not an error");
  // No session lookup with an empty id: that is what returned HTML and crashed.
  assert.equal(h.opencode.prompts.length, 0);
});

test("speaking on the new-session page creates the session and moves the cockpit onto it", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.send({ type: "live", sessionID: "", enabled: true, directory: DIRECTORY });
  await until(() => h.of("state").length > 0, { label: "armed" });
  h.opencode.replyWith('<inject mode="queue">ajoute un test sur le découpage des phrases</inject><say>Je note ça.</say>');

  h.send({ type: "transcript", sessionID: "", text: "ajoute un test sur le découpage des phrases", bargeIn: false, directory: DIRECTORY });

  const navigate = await until(() => h.of("navigate")[0], { label: "navigate" });
  assert.ok(navigate.sessionID.startsWith("ses_"));
  assert.equal(navigate.directory, DIRECTORY);
  assert.equal(navigate.url, sessionUrl(DIRECTORY, navigate.sessionID));

  // The instruction lands in that session, as a real user message. The receipt
  // comes back a round trip later, so wait for it rather than for the prompt.
  const done = await until(() => h.of("inject_done").at(-1), { label: "injection receipt" });
  assert.equal(done.ok, true);
  assert.equal(done.sessionID, navigate.sessionID);
  const injected = h.opencode.prompts.find((p) => p.sessionID === navigate.sessionID && p.async);
  assert.ok(injected, "the instruction must reach the session that was just created");
  assert.equal(injected.body.parts[0].text, "ajoute un test sur le découpage des phrases");
});

test("the url the cockpit is sent to is the one opencode web uses", () => {
  const url = sessionUrl("/home/kpihx/project", "ses_abc");
  const [, dir, , id] = url.split("/");
  assert.equal(Buffer.from(dir, "base64").toString("utf8"), "/home/kpihx/project");
  assert.equal(id, "ses_abc");
});

test("a streamer is bound to the new session, so narration starts immediately", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.send({ type: "live", sessionID: "", enabled: true, directory: DIRECTORY });
  await until(() => h.of("state").length > 0, { label: "armed" });
  h.opencode.replyWith("<reply>C'est parti.</reply>");

  h.send({ type: "transcript", sessionID: "", text: "on commence", bargeIn: false, directory: DIRECTORY });
  const navigate = await until(() => h.of("navigate")[0], { label: "navigate" });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "streamer seeded" });

  const binding = h.daemon.registry.binding(navigate.sessionID);
  assert.ok(binding, "the new session must have a streamer bound to it");
  assert.equal(binding.directory, DIRECTORY);
});

test("without a directory the daemon says so instead of crashing", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());

  h.send({ type: "live", sessionID: "", enabled: true });
  await until(() => h.of("error").length > 0, { label: "error" });
  assert.match(h.of("error")[0].message, /dossier/);

  h.send({ type: "transcript", sessionID: "", text: "fais quelque chose", bargeIn: false });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.opencode.prompts.length, 0, "nothing is sent to a session that cannot exist");
});

test("once the session exists, everything follows the ordinary path", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.send({ type: "live", sessionID: "", enabled: true, directory: DIRECTORY });
  await until(() => h.of("state").length > 0, { label: "armed" });
  h.opencode.replyWith("<reply>On démarre.</reply>");
  h.send({ type: "transcript", sessionID: "", text: "salut", bargeIn: false, directory: DIRECTORY });
  const navigate = await until(() => h.of("navigate")[0], { label: "navigate" });

  // A tool call on the new session narrates normally.
  h.opencode.replyWith("<say>Je regarde le proxy.</say>");
  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: {
      id: "p1",
      sessionID: navigate.sessionID,
      messageID: "m1",
      type: "tool",
      tool: "read",
      callID: "c1",
      state: { status: "completed", input: { filePath: "/a.ts" }, output: "ok", title: "a.ts", metadata: {} },
    },
  });
  await until(() => h.messages.some((m) => m.type === "speak" && m.utterance.kind === "beat"), { label: "narration" });

  const spoken = h.messages.filter((m) => m.type === "speak").map((m) => m.utterance);
  assert.equal(spoken.at(-1).sessionID, navigate.sessionID);
});
