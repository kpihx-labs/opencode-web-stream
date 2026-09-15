import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { FakeOpencode, until } from "../helpers/fake-opencode.mjs";
import { startDaemon } from "../../dist/daemon/index.js";
import { DEFAULTS } from "../../dist/daemon/config.js";
import { Logger } from "../../dist/daemon/log.js";

/**
 * Language follows the user through the whole chain: what they spoke in is
 * what the streamer is told, what every utterance is tagged with, and which
 * voice synthesizes it.
 */

const DIRECTORY = "/tmp/project";

class FakeSpeechServer {
  constructor() {
    this.ttsRequests = [];
    this.sttLanguage = "french";
    this.server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/audio/speech") {
          this.ttsRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
          res.writeHead(200, { "content-type": "audio/wav" });
          res.end(Buffer.alloc(64));
          return;
        }
        if (req.url === "/v1/audio/transcriptions") {
          const body = Buffer.concat(chunks).toString("latin1");
          const forced = body.match(/name="language"\r\n\r\n([^\r]+)/)?.[1];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: "relance les tests", language: forced ?? this.sttLanguage }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
  }
  async listen() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }
  async close() {
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}

async function harness() {
  const opencode = new FakeOpencode();
  const url = await opencode.listen();
  const speech = new FakeSpeechServer();
  await speech.listen();
  const dataDir = mkdtempSync(join(tmpdir(), "ows-lang-"));
  const cfg = {
    ...structuredClone(DEFAULTS),
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "error",
    opencode: { ...DEFAULTS.opencode, url },
    stt: { ...DEFAULTS.stt, url: `${speech.url}/v1/audio/transcriptions`, language: "auto" },
    tts: { ...DEFAULTS.tts, url: `${speech.url}/v1/audio/speech`, voices: { fr: "ff_siwis", en: "af_heart" } },
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
  const send = (m) => ws.send(JSON.stringify(m));
  const spoken = () => messages.filter((m) => m.type === "speak").map((m) => m.utterance);
  return {
    opencode,
    speech,
    daemon,
    send,
    messages,
    spoken,
    async cleanup() {
      ws.close();
      await daemon.stop();
      await opencode.close();
      await speech.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function goLive(h, session) {
  h.send({ type: "live", sessionID: session.id, enabled: true });
  await until(() => h.opencode.prompts.some((p) => p.body.noReply), { label: "seed" });
}

test("utterances carry the session language, french by default", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<say>Je regarde le proxy.</say>");

  h.opencode.emit(DIRECTORY, "message.part.updated", {
    part: { id: "p1", sessionID: session.id, messageID: "m1", type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "/a" }, output: "x", title: "a", metadata: {} } },
  });
  await until(() => h.spoken().length > 0, { label: "speech" });

  assert.equal(h.spoken()[0].lang, "fr");
  const seed = h.opencode.prompts.find((p) => p.body.noReply);
  assert.match(seed.body.parts[0].text, /languages: fr, en \(default fr\)/);
});

test("speaking english switches the session, the streamer's briefing, and the voice", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<reply>Halfway through, tests are left.</reply>");

  h.send({ type: "transcript", sessionID: session.id, text: "where are we at", bargeIn: false, lang: "en-US" });
  await until(() => h.spoken().length > 0, { label: "reply" });

  const voiceAsk = h.opencode.prompts.filter((p) => p.body.parts[0].text.startsWith("[VOICE]")).at(-1);
  assert.match(voiceAsk.body.parts[0].text, /language: en \(recognizer said en-US\)/);
  assert.equal(h.spoken()[0].lang, "en");

  // The cockpit asks for audio in that language and gets the english voice.
  const res = await fetch(`http://127.0.0.1:${h.daemon.port}/api/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: h.spoken()[0].text, lang: h.spoken()[0].lang }),
  });
  assert.equal(res.status, 200);
  assert.equal(h.speech.ttsRequests.at(-1).voice, "af_heart");

  // And the preference survives a restart of the daemon's memory of the session.
  assert.equal(h.daemon.registry.prefs(session.id).lang, "en");
});

test("with no language pinned, whisper's own detection sets the session language", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<reply>Ok.</reply>");
  h.speech.sttLanguage = "english";

  const audio = Buffer.alloc(4000, 1);
  const res = await fetch(`http://127.0.0.1:${h.daemon.port}/api/stt?session=${session.id}`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: audio,
  });
  const body = await res.json();
  assert.equal(body.text, "relance les tests");
  assert.equal(body.language, "en");
  assert.equal(h.daemon.orchestrator.sessions.get(session.id).lang, "en");
});

test("a pinned language overrides whatever whisper would have guessed", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);
  h.opencode.replyWith("<reply>Ok.</reply>");
  h.speech.sttLanguage = "english";

  const res = await fetch(`http://127.0.0.1:${h.daemon.port}/api/stt?session=${session.id}&lang=fr-FR`, {
    method: "POST",
    headers: { "content-type": "audio/webm" },
    body: Buffer.alloc(4000, 1),
  });
  const body = await res.json();
  assert.equal(body.language, "fr-FR");
  assert.equal(h.daemon.orchestrator.sessions.get(session.id).lang, "fr");
});

test("the cockpit can pin the language through its preferences", async (t) => {
  const h = await harness();
  t.after(() => h.cleanup());
  const session = h.opencode.addSession({ id: "ses_main", directory: DIRECTORY });
  await goLive(h, session);

  h.send({ type: "prefs", sessionID: session.id, lang: "en-US" });
  await until(() => h.daemon.orchestrator.sessions.get(session.id).lang === "en", { label: "pref applied" });
  const status = await (await fetch(`http://127.0.0.1:${h.daemon.port}/api/status`)).json();
  assert.deepEqual(status.speech, { languages: ["fr", "en"], default: "fr" });
  assert.equal(status.sessions.find((s) => s.sessionID === session.id).lang, "en");
});
