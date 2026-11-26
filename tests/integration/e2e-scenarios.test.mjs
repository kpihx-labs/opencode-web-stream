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
import { MAX_UTTERANCE_CHARS } from "../../dist/shared/protocol.js";

const DIRECTORY = "/tmp/project";

async function setup(overrides = {}) {
  const opencode = new FakeOpencode();
  const url = await opencode.listen();
  const dataDir = mkdtempSync(join(tmpdir(), "ows-e2e-"));
  const cfg = {
    ...structuredClone(DEFAULTS),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "error",
    opencode: { ...DEFAULTS.opencode, url },
    decision: { ...DEFAULTS.decision, enabled: false },
    stt: { ...DEFAULTS.stt, mode: "browser", url: "" },
    tts: { ...DEFAULTS.tts, mode: "off", url: "" },
    streamer: { ...DEFAULTS.streamer, injectDelayMs: 20, blockedRepeatMs: 0, ...overrides.streamer },
    beats: { ...DEFAULTS.beats, windowMs: 60, ttlMs: 8000, ...overrides.beats },
    answer: { ...DEFAULTS.answer, ...overrides.answer },
    lexicon: { ...DEFAULTS.lexicon, maxFiles: 50, maxTerms: 100 },
  };
  const daemon = await startDaemon(cfg, { logger: new Logger({ level: "error" }) });
  await opencode.waitForSubscriber();
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/stream`);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const msgs = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  return {
    opencode,
    daemon,
    msgs,
    send: (m) => ws.send(JSON.stringify(m)),
    spoken: () => msgs.filter((m) => m.type === "speak").map((m) => m.utterance),
    async cleanup() {
      ws.close();
      await daemon.stop();
      await opencode.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("long untagged digest reply is split into multiple bounded sentences, never one huge TTS blob", async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_long", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  const longReply =
    "Première phrase claire et détaillée sur le résultat complet de la recherche scientifique menée. " +
    "Deuxième phrase détaillée avec des informations complémentaires très utiles sur le projet STARLite, les expériences en cours et les paramètres de physique des plasmas mesurés au laboratoire. " +
    "Troisième phrase qui explique les publications récentes, les collaborations académiques internationales et les résultats expérimentaux obtenus au MIT Plasma Science and Fusion Center. " +
    "Quatrième phrase qui conclut proprement l'ensemble de la synthèse orale pour l'utilisateur sans couper aucun détail important.";
  assert.ok(longReply.length > MAX_UTTERANCE_CHARS);
  h.opencode.replyWith(`<reply>${longReply}</reply>`);
  // Simulate slow/non-streaming assistant completion where onStreamerDelta did not speak incrementally.
  h.send({ type: "transcript", sessionID: session.id, text: "résume tout", bargeIn: false, directory: DIRECTORY });
  await until(() => h.spoken().length >= 3, { label: "split sentences" });
  for (const u of h.spoken()) {
    assert.ok(u.text.length <= MAX_UTTERANCE_CHARS, `chunk too large: ${u.text.length}`);
  }
});

test("already-speaking answer stream is NOT cancelled mid-way when a markdown list appears later", async (t) => {
  const h = await setup({ answer: { mode: "full" } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_md", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  const msgId = "msg_ans_1";
  const partId = "prt_ans_1";
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "busy" } });
  h.opencode.emit(DIRECTORY, "message.updated", { info: { id: msgId, sessionID: session.id, role: "assistant", time: { created: Date.now() } } });
  const p1 = "Voici le début de la réponse parlée directement à haute voix. ";
  h.opencode.emit(DIRECTORY, "message.part.updated", { part: { id: partId, sessionID: session.id, messageID: msgId, type: "text", text: p1 } });
  await until(() => h.spoken().length >= 1, { label: "first sentence spoken" });

  const p2 = p1 + "\n- premier point\n- deuxième point\n- troisième point\n- quatrième point\n";
  h.opencode.emit(DIRECTORY, "message.part.updated", { part: { id: partId, sessionID: session.id, messageID: msgId, type: "text", text: p2 } });
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await new Promise((r) => setTimeout(r, 120));

  const cancels = h.msgs.filter((m) => m.type === "cancel");
  assert.equal(cancels.length, 0, "must not cancel mid-playback once sentences already started");
});

test("fallback injection queues cleanly without hardcoded canned speech when streamer times out", async (t) => {
  const h = await setup({ streamer: { voiceTimeoutMs: 60, beatTimeoutMs: 60 }, beats: { windowMs: 30 } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_fb", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  // Make streamer hang past timeout; fallback must still queue raw transcript without any hardcoded phrase.
  h.opencode.promptDelayMs = 200;

  h.send({ type: "transcript", sessionID: session.id, text: "lance une analyse complète", bargeIn: false, directory: DIRECTORY });
  await until(() => h.msgs.some((m) => m.type === "inject_done"), { label: "fallback inject" });
  const injected = h.opencode.prompts.find((p) => p.sessionID === session.id && p.async);
  assert.equal(injected?.body.parts?.[0]?.text, "lance une analyse complète");
});

test("late message.part.updated after session.idle does not double-speak an already finished answer", async (t) => {
  const h = await setup({ answer: { mode: "full" } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_dup", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  const msgId = "msg_dup_1";
  const partId = `${msgId}:text`;
  const text = "Voici une réponse unique qui ne doit jamais être relue deux fois.";
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "busy" } });
  h.opencode.emit(DIRECTORY, "message.updated", { info: { id: msgId, sessionID: session.id, role: "assistant", time: { created: Date.now() } } });
  h.opencode.emit(DIRECTORY, "message.part.updated", { part: { id: partId, sessionID: session.id, messageID: msgId, type: "text", text } });
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await until(() => h.spoken().length === 1, { label: "spoken once" });

  // Late V2 reconciliation event arrives after idle: must NOT re-speak.
  h.opencode.emit(DIRECTORY, "message.part.updated", { part: { id: partId, sessionID: session.id, messageID: msgId, type: "text", text } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.spoken().length, 1);
});

test("preliminary heard arrives before reply speech and activeAnswerStreamId is cancelled after idle", async (t) => {
  const h = await setup({ answer: { mode: "full" } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_chrono", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  // Stream an answer and finish to idle.
  const msgId = "msg_ans_fin";
  const partId = `${msgId}:text`;
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "busy" } });
  h.opencode.emit(DIRECTORY, "message.updated", { info: { id: msgId, sessionID: session.id, role: "assistant", time: { created: Date.now() } } });
  h.opencode.emit(DIRECTORY, "message.part.updated", { part: { id: partId, sessionID: session.id, messageID: msgId, type: "text", text: "Première phrase de l'agent. Deuxième phrase longue." } });
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await until(() => h.spoken().length >= 2, { label: "answer spoken" });

  const startIdx = h.msgs.length;
  h.opencode.replyWith("<reply>Voici la priorité unique.</reply>");
  h.send({ type: "transcript", sessionID: session.id, text: "Quelle est la priorité unique ?", bargeIn: false, directory: DIRECTORY });
  await until(() => h.msgs.slice(startIdx).some((m) => m.type === "heard" && m.decision === "reply"), { label: "final heard" });

  const slice = h.msgs.slice(startIdx);
  const prelimIdx = slice.findIndex((m) => m.type === "heard" && m.decision === "…");
  const speakIdx = slice.findIndex((m) => m.type === "speak");
  assert.ok(prelimIdx >= 0 && speakIdx > prelimIdx, "heard must appear chronologically before reply speech");
  assert.ok(slice.some((m) => m.type === "cancel" && String(m.streamId || "").startsWith(`ans_${msgId}`)), "finished answer streamId must be cancelled on follow-up reply");
});

test("default digest mode never sends raw main-agent text to TTS and presents cleanly via streamer", async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_digest_def", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  h.opencode.replyWith("<reply>Tu as 35 projets actifs dans ton contexte.</reply>");
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "busy" } });
  h.opencode.emit(DIRECTORY, "message.updated", { info: { id: "msg_raw", sessionID: session.id, role: "assistant", time: { created: Date.now() } } });
  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: {
      id: "msg_raw:text",
      sessionID: session.id,
      messageID: "msg_raw",
      type: "text",
      text: "💬 **Comments** — The k-context skill is massively detailed (244 lines) and serves as the canonical HOT context.",
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.spoken().length, 0, "raw main-agent prose must NEVER go directly to TTS while streaming");

  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await until(() => h.spoken().length === 1, { label: "streamer digest spoken" });
  assert.equal(h.spoken()[0].text, "Tu as 35 projets actifs dans ton contexte.");
  assert.equal(h.spoken()[0].kind, "reply");
});

test("newer voice turn supersedes stalled voice turn without fallback-injecting the stale prompt", async (t) => {
  const h = await setup();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_super", directory: DIRECTORY });
  h.send({ type: "attach", sessionID: session.id, directory: DIRECTORY, protocol: 5, visible: true });
  h.send({ type: "live", sessionID: session.id, enabled: true, directory: DIRECTORY });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seeded" });

  // Stall first voice prompt so user re-asks before firstToken arrives.
  h.opencode.promptDelayMs = 350;
  h.opencode.replyWith("<reply>Première réponse obsolète.</reply>");
  h.send({ type: "transcript", sessionID: session.id, text: "Dis-moi plus sur toi", bargeIn: false, directory: DIRECTORY });
  await new Promise((r) => setTimeout(r, 80));

  h.opencode.promptDelayMs = 0;
  h.opencode.replyWith("<reply>Voici la réponse directe.</reply>");
  h.send({ type: "transcript", sessionID: session.id, text: "Que sais-tu faire ?", bargeIn: false, directory: DIRECTORY });

  await until(() => h.msgs.some((m) => m.type === "heard" && m.decision === "superseded"), { label: "turn 1 superseded" });
  await until(() => h.msgs.some((m) => m.type === "heard" && m.raw === "Que sais-tu faire ?" && m.decision === "reply"), { label: "turn 2 replied" });
  await until(() => h.spoken().some((s) => s.text === "Voici la réponse directe."), { label: "turn 2 spoken" });

  assert.equal(h.msgs.some((m) => m.type === "inject_done"), false, "superseded voice turn must NEVER trigger fallback injection");
  assert.equal(h.spoken().some((s) => s.text.includes("obsolète")), false, "superseded voice turn must not speak");
});
