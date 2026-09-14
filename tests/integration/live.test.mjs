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

/**
 * End to end through the real daemon: a fake OpenCode on one side speaking the
 * real SSE and REST shapes, a fake cockpit on the other speaking the real
 * websocket protocol. Nothing is stubbed in between.
 */

const DIRECTORY = "/tmp/project";

class Cockpit {
  constructor(url) {
    this.url = url;
    this.messages = [];
    this.spoken = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.type === "speak") this.spoken.push(msg.utterance);
    });
    return this;
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  of(type) {
    return this.messages.filter((m) => m.type === type);
  }

  /** Everything that was spoken, joined, for readable assertions. */
  said() {
    return this.spoken.map((u) => u.text).join(" ");
  }

  close() {
    this.ws?.close();
  }
}

async function harness(overrides = {}) {
  const opencode = new FakeOpencode();
  const url = await opencode.listen();
  const dataDir = mkdtempSync(join(tmpdir(), "ows-test-"));
  const cfg = {
    ...structuredClone(DEFAULTS),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "error",
    opencode: { ...DEFAULTS.opencode, url },
    // No speech engines in tests: the cockpit would fall back to the browser.
    stt: { ...DEFAULTS.stt, url: "" },
    tts: { ...DEFAULTS.tts, url: "" },
    streamer: { ...DEFAULTS.streamer, injectDelayMs: 20, blockedRepeatMs: 0, ...overrides.streamer },
    beats: { ...DEFAULTS.beats, windowMs: 60, ttlMs: 5000, ...overrides.beats },
    answer: { ...DEFAULTS.answer, ...overrides.answer },
    lexicon: { ...DEFAULTS.lexicon, maxFiles: 50, maxTerms: 100 },
  };
  const daemon = await startDaemon(cfg, { logger: new Logger({ level: "error" }) });
  await opencode.waitForSubscriber();
  const cockpit = await new Cockpit(`ws://127.0.0.1:${daemon.port}/ws/stream`).connect();
  return {
    opencode,
    daemon,
    cockpit,
    async cleanup() {
      cockpit.close();
      await daemon.stop();
      await opencode.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Bring a session to life and wait until the streamer has been seeded. */
async function goLive(h, session) {
  h.cockpit.send({ type: "live", sessionID: session.id, enabled: true });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "context seed" });
  const seed = h.opencode.prompts.find((p) => p.body.noReply);
  return seed.sessionID;
}

function toolEvent(sessionID, tool, input, output = "ok") {
  return {
    part: {
      id: `prt_${Math.random().toString(36).slice(2, 8)}`,
      sessionID,
      messageID: "msg_a",
      type: "tool",
      tool,
      callID: `call_${Math.random().toString(36).slice(2, 8)}`,
      state: { status: "completed", input, output, title: tool, metadata: {}, time: { start: 1, end: 2 } },
    },
  };
}

test("going live creates a streamer session, seeds it, and nothing more", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", title: "fix the proxy", directory: DIRECTORY });

  const streamerID = await goLive(h, session);

  assert.notEqual(streamerID, session.id, "the streamer must be its own session");
  const seed = h.opencode.prompts.find((p) => p.body.noReply);
  assert.equal(seed.body.agent, "streamer");
  assert.equal(seed.body.model.providerID, "opencode-go");
  assert.match(seed.body.parts[0].text, /^\[CONTEXT\]/);
  assert.match(seed.body.parts[0].text, /fix the proxy/);
  // Seeding must not make the model talk.
  assert.equal(h.opencode.prompts.filter((p) => !p.body.noReply).length, 0);
  assert.equal(h.cockpit.spoken.length, 0);
});

test("a beat is windowed, asked once, and spoken when the streamer says so", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<say>Je remonte la trace du timeout dans le proxy.</say>");

  for (const file of ["a.ts", "b.ts", "c.ts"]) {
    h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "read", { filePath: `/p/${file}` }));
  }
  await until(() => h.cockpit.spoken.length > 0, { label: "narration" });

  const asks = h.opencode.prompts.filter((p) => !p.body.noReply);
  assert.equal(asks.length, 1, "three tools in one window must produce one question");
  assert.match(asks[0].body.parts[0].text, /^\[BEAT\]/);
  assert.equal(asks[0].body.parts[0].text.match(/- read/g).length, 3);
  assert.equal(h.cockpit.said(), "Je remonte la trace du timeout dans le proxy.");
  assert.equal(h.cockpit.spoken[0].kind, "beat");
});

test("a quiet streamer produces silence, not an empty utterance", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<quiet/>");

  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "read", { filePath: "/p/a.ts" }));
  await until(() => h.opencode.prompts.some((p) => p.body.parts[0].text.startsWith("[BEAT]")), { label: "beat asked" });
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(h.cockpit.spoken.length, 0);
});

test("the final answer is spoken as it streams, sentence by sentence", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);

  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: { id: "prt_text", sessionID: session.id, messageID: "msg_ans", type: "text", text: "" },
  });
  const deltas = ["Le timeout venait du proxy. ", "Je l'ai passé à trente secondes. ", "Les tests passent."];
  for (const delta of deltas) {
    h.opencode.emit(DIRECTORY, "message.part.delta", {
      sessionID: session.id,
      messageID: "msg_ans",
      partID: "prt_text",
      field: "text",
      delta,
    });
  }
  await until(() => h.cockpit.spoken.length >= 2, { label: "streamed answer" });
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await until(() => h.cockpit.spoken.length >= 3, { label: "final sentence" });

  assert.equal(h.cockpit.spoken[0].kind, "answer");
  assert.equal(h.cockpit.spoken[0].text, "Le timeout venait du proxy.");
  assert.equal(h.cockpit.spoken[2].text, "Les tests passent.");
  // One stream, strictly ordered.
  const streamIds = new Set(h.cockpit.spoken.map((u) => u.streamId));
  assert.equal(streamIds.size, 1);
  assert.deepEqual(h.cockpit.spoken.map((u) => u.streamSeq), [0, 1, 2]);
  // Reading the answer must not cost a model call.
  assert.equal(h.opencode.prompts.filter((p) => !p.body.noReply).length, 0);
});

test("reasoning deltas are never spoken", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);

  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: { id: "prt_think", sessionID: session.id, messageID: "msg_ans", type: "reasoning", text: "" },
  });
  h.opencode.emit(DIRECTORY, "message.part.delta", {
    sessionID: session.id,
    messageID: "msg_ans",
    partID: "prt_think",
    field: "text",
    delta: "Hmm, peut-être que le proxy.",
  });
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(h.cockpit.spoken.length, 0);
});

test("voice becomes a cleaned injection, acknowledged out loud", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith('<inject mode="queue">ajoute un test sur le découpage des phrases</inject><say>Je note ça pour la suite.</say>');

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "ajoute un test sur le découpage dé phrase", bargeIn: false, lang: "fr-FR" });
  await until(() => h.opencode.prompts.some((p) => p.sessionID === session.id && p.async), { label: "injection" });

  const injected = h.opencode.prompts.find((p) => p.sessionID === session.id && p.async);
  assert.equal(injected.body.parts[0].text, "ajoute un test sur le découpage des phrases");
  assert.equal(h.opencode.aborts.length, 0, "queue mode must not abort");
  assert.equal(h.cockpit.said(), "Je note ça pour la suite.");

  const heard = h.cockpit.of("heard").at(-1);
  assert.equal(heard.raw, "ajoute un test sur le découpage dé phrase");
  assert.equal(heard.corrected, "ajoute un test sur le découpage des phrases");
  assert.equal(heard.decision, "inject:queue");

  const pending = h.cockpit.of("inject_pending").at(-1);
  assert.equal(pending.mode, "queue");
  assert.ok(h.cockpit.of("inject_done").at(-1).ok);
});

test("interrupt mode aborts the session before injecting", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "busy" } });
  h.opencode.replyWith('<inject mode="interrupt">laisse tomber, regarde plutôt le démon</inject><say>Ok, je change de cap.</say>');

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "stop, regarde plutôt le démon", bargeIn: true, spokenOver: "Je lis le proxy", lang: "fr-FR" });
  await until(() => h.opencode.aborts.length > 0, { label: "abort" });
  h.opencode.emit(DIRECTORY, "session.status", { sessionID: session.id, status: { type: "idle" } });
  await until(() => h.opencode.prompts.some((p) => p.sessionID === session.id && p.async), { label: "injection after abort" });

  assert.deepEqual(h.opencode.aborts, [session.id]);
  const voiceAsk = h.opencode.prompts.filter((p) => !p.body.noReply && p.body.parts[0].text.startsWith("[VOICE]")).at(-1);
  assert.match(voiceAsk.body.parts[0].text, /cut you off while you were saying: Je lis le proxy/);
});

test("a scheduled injection can be cancelled from the cockpit", async (t) => {
  const h = await harness({ streamer: { injectDelayMs: 400 } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith('<inject mode="queue">supprime le dossier</inject><say>Je le fais.</say>');

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "supprime le dossier", bargeIn: false });
  const pending = await until(() => h.cockpit.of("inject_pending").at(-1), { label: "pending injection" });
  h.cockpit.send({ type: "cancel_inject", sessionID: session.id, injectId: pending.injectId });
  await until(() => h.cockpit.of("inject_done").at(-1), { label: "cancellation" });
  await new Promise((r) => setTimeout(r, 400));

  const done = h.cockpit.of("inject_done").at(-1);
  assert.equal(done.ok, false);
  assert.equal(done.error, "cancelled");
  assert.equal(h.opencode.prompts.filter((p) => p.sessionID === session.id && p.async).length, 0);
});

test("a question the streamer can answer never reaches the main agent", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<reply>On en est à la moitié, il reste les tests.</reply>");

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "on en est où ?", bargeIn: false });
  await until(() => h.cockpit.spoken.length > 0, { label: "direct reply" });

  assert.equal(h.cockpit.said(), "On en est à la moitié, il reste les tests.");
  assert.equal(h.opencode.prompts.filter((p) => p.sessionID === session.id && p.async).length, 0);
  assert.equal(h.opencode.aborts.length, 0);
});

test("noise is discarded and the voice resumes where it was cut", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<quiet/>");

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "euh", bargeIn: true, spokenOver: "Je lis la config" });
  await until(() => h.cockpit.of("resume").length > 0, { label: "resume" });

  assert.equal(h.cockpit.spoken.length, 0);
  assert.equal(h.cockpit.of("heard").at(-1).decision, "quiet");
});

test("a pending permission is announced and can be answered by voice", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<say>Je veux lancer la migration sur la base locale, tu me confirmes ?</say>");

  h.opencode.emit(DIRECTORY, "permission.asked", {
    id: "per_1",
    sessionID: session.id,
    permission: "bash",
    patterns: ["npm run migrate"],
    metadata: { command: "npm run migrate" },
    always: [],
  });
  await until(() => h.cockpit.spoken.some((u) => u.kind === "blocked"), { label: "blocked narration" });

  const state = h.cockpit.of("state").at(-1);
  assert.equal(state.state, "waiting_user");
  assert.equal(state.blocked.kind, "permission");

  h.opencode.replyWith('<permission answer="once"/><say>C\'est parti.</say>');
  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "oui vas-y", bargeIn: false });
  await until(() => h.opencode.permissionReplies.length > 0, { label: "permission reply" });

  assert.deepEqual(h.opencode.permissionReplies[0], { sessionID: session.id, permissionID: "per_1", response: "once" });
});

test("a pending question is answered with the option labels", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<say>Tu veux que je parte sur Postgres ou SQLite ?</say>");

  h.opencode.emit(DIRECTORY, "question.asked", {
    id: "que_1",
    sessionID: session.id,
    questions: [{ question: "Quelle base ?", header: "base", options: [{ label: "Postgres", description: "serveur" }, { label: "SQLite", description: "fichier" }] }],
  });
  await until(() => h.cockpit.spoken.some((u) => u.kind === "blocked"), { label: "question narration" });

  h.opencode.replyWith(`<question answers='[["SQLite"]]'/><say>Va pour SQLite.</say>`);
  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "prends sequel light", bargeIn: false });
  await until(() => h.opencode.questionReplies.length > 0, { label: "question reply" });

  assert.deepEqual(h.opencode.questionReplies[0].answers, [["SQLite"]]);
});

test("an error is announced but our own abort is not", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);

  h.opencode.emit(DIRECTORY, "session.error", { sessionID: session.id, error: { name: "MessageAbortedError", data: {} } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.cockpit.spoken.length, 0, "an abort is not an error");

  h.opencode.replyWith("<say>Le provider ne répond pas, je retente.</say>");
  h.opencode.emit(DIRECTORY, "session.error", { sessionID: session.id, error: { name: "ProviderAuthError", data: { message: "401" } } });
  await until(() => h.cockpit.spoken.length > 0, { label: "error narration" });
  assert.equal(h.cockpit.spoken[0].kind, "blocked");
});

test("subagent tools feed the parent's narration, not a second streamer", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const parent = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, parent);
  h.opencode.replyWith("<say>Je fouille le dépôt en parallèle.</say>");

  const child = h.opencode.addSession({ id: "ses_child", directory: DIRECTORY, parentID: parent.id, agent: "explore" });
  h.opencode.emit(DIRECTORY, "session.created", { info: child });
  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(child.id, "grep", { pattern: "TODO" }));
  await until(() => h.cockpit.spoken.length > 0, { label: "subagent narration" });

  const beat = h.opencode.prompts.filter((p) => p.body.parts[0].text.startsWith("[BEAT]")).at(-1);
  assert.match(beat.body.parts[0].text, /via explore/);
  // One streamer session, bound to the parent.
  const created = h.opencode.prompts.filter((p) => p.body.noReply).map((p) => p.sessionID);
  assert.equal(new Set(created).size, 1);
});

test("a typed message is context for the streamer, never a reason to speak", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);

  h.opencode.emit(DIRECTORY, "message.updated", {
    info: { id: "msg_typed", sessionID: session.id, role: "user", time: { created: Date.now() } },
  });
  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: { id: "prt_typed", sessionID: session.id, messageID: "msg_typed", type: "text", text: "refais le hub en plus simple" },
  });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply && p.body.parts[0].text.startsWith("[TYPED]")), { label: "typed context" });
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(h.cockpit.spoken.length, 0);
});

test("an off-format answer is treated as silence, never read aloud", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("Je pense que ce serait bien de regarder le proxy mais je ne suis pas sûr.");

  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "read", { filePath: "/p/a.ts" }));
  await until(() => h.opencode.prompts.some((p) => p.body.parts[0].text.startsWith("[BEAT]")), { label: "beat asked" });
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(h.cockpit.spoken.length, 0);
});

test("an unreachable streamer still gets the user's words to the agent", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.failNextPrompt = 500;

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "relance les tests", bargeIn: false });
  await until(() => h.opencode.prompts.some((p) => p.sessionID === session.id && p.async), { label: "fallback injection" });

  const injected = h.opencode.prompts.find((p) => p.sessionID === session.id && p.async);
  assert.equal(injected.body.parts[0].text, "relance les tests");
  assert.match(h.cockpit.of("heard").at(-1).decision, /fallback/);
});

test("the streamer learns an alias and the cockpit gets the new vocabulary", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith('<reply>Oui, le démon tourne.</reply><learn heard="démone" canonical="daemon"/>');

  h.cockpit.send({ type: "transcript", sessionID: session.id, text: "la démone elle tourne ?", bargeIn: false });
  await until(() => h.cockpit.of("lexicon").length > 1, { label: "lexicon update" });

  assert.ok(h.daemon.registry.aliases().some((a) => a.heard === "démone" && a.canonical === "daemon"));
  assert.ok(h.cockpit.of("lexicon").at(-1).phrases.includes("daemon"));
});

test("live off stops every model call and keeps the session for later", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  const streamerID = await goLive(h, session);
  const before = h.opencode.prompts.length;

  h.cockpit.send({ type: "live", sessionID: session.id, enabled: false });
  await until(() => h.cockpit.of("state").some((s) => s.state === "idle"), { label: "idle state" });
  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "read", { filePath: "/p/a.ts" }));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(h.opencode.prompts.length, before, "no model call once live is off");
  assert.equal(h.daemon.registry.binding(session.id).streamerID, streamerID, "the binding survives");
});

test("a restarted daemon reuses the streamer session it had bound", async (t) => {
  const opencode = new FakeOpencode();
  const url = await opencode.listen();
  const dataDir = mkdtempSync(join(tmpdir(), "ows-restart-"));
  const base = {
    ...structuredClone(DEFAULTS),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "error",
    opencode: { ...DEFAULTS.opencode, url },
    stt: { ...DEFAULTS.stt, url: "" },
    tts: { ...DEFAULTS.tts, url: "" },
    beats: { ...DEFAULTS.beats, windowMs: 60 },
  };
  const session = opencode.addSession({ id: "ses_main", directory: DIRECTORY });

  const first = await startDaemon(base, { logger: new Logger({ level: "error" }) });
  await opencode.waitForSubscriber();
  const c1 = await new Cockpit(`ws://127.0.0.1:${first.port}/ws/stream`).connect();
  c1.send({ type: "live", sessionID: session.id, enabled: true });
  await until(() => opencode.prompts.some((p) => p.body.noReply), { label: "first seed" });
  const streamerID = opencode.prompts.find((p) => p.body.noReply).sessionID;
  c1.close();
  await first.stop();

  const second = await startDaemon(base, { logger: new Logger({ level: "error" }) });
  await opencode.waitForSubscriber();
  const c2 = await new Cockpit(`ws://127.0.0.1:${second.port}/ws/stream`).connect();
  opencode.prompts.length = 0;
  c2.send({ type: "live", sessionID: session.id, enabled: true });
  await until(() => opencode.prompts.some((p) => p.body.noReply), { label: "second seed" });

  assert.equal(opencode.prompts.find((p) => p.body.noReply).sessionID, streamerID);
  c2.close();
  await second.stop();
  await opencode.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a vanished streamer session is recreated rather than lost", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  const streamerID = await goLive(h, session);

  // OpenCode forgot the session, as after a data reset.
  h.opencode.sessions.delete(streamerID);
  h.opencode.replyWith("<say>Je reprends.</say>");
  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "bash", { command: "npm test" }));
  await until(() => h.cockpit.spoken.length > 0, { timeoutMs: 6000, label: "recovery" });

  assert.notEqual(h.daemon.registry.binding(session.id).streamerID, streamerID);
  assert.equal(h.cockpit.said(), "Je reprends.");
});

test("a stale beat is dropped rather than narrated late", async (t) => {
  const h = await harness({ beats: { ttlMs: 30 }, streamer: { beatTimeoutMs: 2000 } });
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<say>Voilà ce que je fais.</say>");
  h.opencode.promptDelayMs = 200;

  h.opencode.emit(DIRECTORY, "message.part.updated", toolEvent(session.id, "read", { filePath: "/p/a.ts" }));
  await until(() => h.cockpit.spoken.length > 0, { label: "expired utterance emitted" });

  // The daemon still emits it, marked with the deadline it already missed.
  const utterance = h.cockpit.spoken[0];
  assert.ok(utterance.expiresAt > 0);
  assert.ok(utterance.expiresAt < Date.now(), "the cockpit must be told this is stale");
});

test("the http surface reports health, status and logs", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const base = `http://127.0.0.1:${h.daemon.port}`;

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ok");
  assert.equal(health.opencode, true);

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.tts.engine, "browser", "no server tts configured in tests");
  assert.equal(status.stt.engine, "browser");

  const logs = await (await fetch(`${base}/api/logs?limit=5`)).json();
  assert.ok(Array.isArray(logs));
  for (const entry of logs) {
    assert.ok(typeof entry.level === "string");
    assert.ok(typeof entry.scope === "string");
    assert.ok(typeof entry.msg === "string");
  }

  // The same routes answer behind the Lens proxy prefix.
  const proxied = await (await fetch(`${base}/__stream__/health`)).json();
  assert.equal(proxied.status, "ok");
});

test("a cockpit on the wrong protocol version is told to reload", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  h.cockpit.send({ type: "attach", sessionID: "ses_main", protocol: 1, visible: true });
  await until(() => h.cockpit.of("reload").length > 0, { label: "reload" });
  assert.match(h.cockpit.of("reload")[0].reason, /protocol 1/);
});
