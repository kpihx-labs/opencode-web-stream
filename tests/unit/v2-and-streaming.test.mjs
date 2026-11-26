import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig } from "../../dist/daemon/config.js";
import { OpencodeClient } from "../../dist/daemon/opencode/client.js";
import { DecisionEngine } from "../../dist/daemon/engines/decision.js";
import { SttEngine } from "../../dist/daemon/engines/stt.js";
import { normalizeEdgeVoice, generateSecMsGecV2 } from "../../dist/daemon/engines/edge-tts.js";
import { isEchoOfSpoken } from "../../dist/daemon/core/orchestrator.js";
import { Registry } from "../../dist/daemon/core/registry.js";
import { StreamerSession } from "../../dist/daemon/core/streamer.js";
import { Logger } from "../../dist/daemon/log.js";

const log = new Logger({ level: "fatal" }).scope("test");
const bundle = readFileSync(new URL("../../dist/plugin.js", import.meta.url), "utf8");

function extract(name, deps = "") {
  const start = bundle.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in the bundle`);
  let depth = 0;
  let i = bundle.indexOf("{", start);
  for (; i < bundle.length; i++) {
    if (bundle[i] === "{") depth++;
    else if (bundle[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return new Function(`${deps}\n${bundle.slice(start, i + 1)}\nreturn ${name};`)();
}

test("normalizeEdgeVoice maps stale Kokoro voices and generates valid Sec-MS-GEC v2 tokens", () => {
  assert.equal(normalizeEdgeVoice("ff_siwis", "fr"), "fr-FR-DeniseNeural");
  assert.equal(normalizeEdgeVoice("af_heart", "en-US"), "en-US-JennyNeural");
  assert.equal(normalizeEdgeVoice("fr-FR-HenriNeural", "fr"), "fr-FR-HenriNeural");
  assert.equal(
    generateSecMsGecV2(1795700000),
    "06974931002A3732-87A7B23528F7F5F14C9659A7CD174A48FF12501804CA538B8BA073B9101F9B8D",
  );
  assert.equal(
    generateSecMsGecV2(1795700831),
    "2D7F5CB393A6E7F1-AE1514119CEEFA866F9E40071D8C38AB08D14F24921D7BE62BD70705416D7751",
  );
});

test("DecisionEngine parses Ollaya /v1/systemone Choice and Noul responses", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/v1/models")) {
      return new Response(JSON.stringify({ models: [{ name: "largha:latest" }] }), { status: 200 });
    }
    seen.push(JSON.parse(init.body));
    const state = seen.at(-1).state;
    const qs = seen.at(-1).questions;
    if (qs.intent) {
      if (state.includes("tais-toi")) {
        return new Response(JSON.stringify({ answers: { intent: { type: "choice", choice: "stop", confidence: 0.4, probabilities: { stop: 0.72, noise: 0.14, pass: 0.14 } } } }), { status: 200 });
      }
      if (state.includes("euh")) {
        return new Response(JSON.stringify({ answers: { intent: { type: "choice", choice: "noise", confidence: 0.3, probabilities: { stop: 0.15, noise: 0.61, pass: 0.24 } } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ answers: { intent: { type: "choice", choice: "pass", confidence: 0.5, probabilities: { stop: 0.1, noise: 0.1, pass: 0.8 } } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ answers: { worth_speaking: { type: "noul", noul: 0.22 } } }), { status: 200 });
  };

  const engine = new DecisionEngine(DEFAULTS.decision, log, fakeFetch);
  assert.equal(await engine.check(true), true);
  assert.equal(await engine.triageVoice("tais-toi", { speaking: true, busy: false }), "stop");
  assert.equal(await engine.triageVoice("euh", { speaking: true, busy: false }), "noise");
  assert.equal(await engine.triageVoice("bonjour", { speaking: false, busy: false }), "pass");
  assert.equal(await engine.triageBeat("read file foo.ts"), false);
  assert.equal(seen.at(-1).model, "largha");
});

test("DecisionEngine degrades to pass/true when local Ollaya is offline", async () => {
  const downFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const engine = new DecisionEngine(DEFAULTS.decision, log, downFetch);
  assert.equal(await engine.check(true), false);
  assert.equal(await engine.triageVoice("euh", { speaking: true, busy: false }), "pass");
  assert.equal(await engine.triageBeat("anything"), true);
});

test("OpencodeClient translates V2 SSE events and wraps V2 REST routes", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/api/info") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version: "2.4.2" }));
        return;
      }
      if (req.url === "/api/session/active") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { ses_1: { type: "running" } } }));
        return;
      }
      if (req.url.startsWith("/api/session/ses_1/message")) {
        res.writeHead(200, { "content-type": "application/json" });
        // Server returns newest first; client must sort oldest first.
        res.end(
          JSON.stringify({
            data: [
              { id: "msg_2", type: "assistant", time: { created: 200, completed: 250 }, content: [{ type: "text", text: "Done." }] },
              { id: "msg_1", type: "user", time: { created: 100 }, content: [{ type: "text", text: "Hi" }] },
            ],
          }),
        );
        return;
      }
      if (req.url === "/api/event") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "session.inbox.enqueued", created: 10, location: { directory: "/repo" }, data: { sessionID: "ses_1", inboxID: "msg_u1", item: { type: "user", payload: { text: "Check tests" } } } },
          { type: "session.text.started", created: 11, location: { directory: "/repo" }, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0 } },
          { type: "session.text.delta", created: 12, location: { directory: "/repo" }, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, delta: "All " } },
          { type: "session.text.ended", created: 13, location: { directory: "/repo" }, data: { sessionID: "ses_1", assistantMessageID: "msg_a1", ordinal: 0, text: "All good." } },
          { type: "permission.asked", created: 14, location: { directory: "/repo" }, data: { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["ls"] } },
          { type: "form.created", created: 15, location: { directory: "/repo" }, data: { form: { id: "frm_1", sessionID: "ses_1", title: "Pick", fields: [{ id: "q", label: "Mode?", type: "select", options: [{ label: "Fast" }] }] } } },
        ];
        for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const client = new OpencodeClient({ baseUrl, username: "opencode", password: "secret", log });
  assert.equal(await client.resolveMode(), "v2");
  assert.equal(requests[0].auth, `Basic ${Buffer.from("opencode:secret").toString("base64")}`);

  const active = await client.sessionStatus("/repo");
  assert.deepEqual(active, { ses_1: { type: "busy" } });

  const msgs = await client.messages("ses_1", "/repo");
  assert.deepEqual(msgs.map((m) => m.info.id), ["msg_1", "msg_2"]);

  await client.replyQuestion("/repo", "frm_1", [["Fast"]], "ses_1");
  const formReq = requests.find((r) => r.url === "/api/session/ses_1/form/frm_1/reply");
  assert.ok(formReq);
  assert.deepEqual(JSON.parse(formReq.body), { answer: { "0": "Fast" } });

  const received = [];
  const abort = new AbortController();
  await client.subscribeGlobal(
    (env) => {
      received.push(env.payload);
      if (received.some((p) => p.type === "question.asked")) abort.abort();
    },
    { signal: abort.signal },
  );
  assert.ok(received.some((p) => p.type === "message.updated" && p.properties.info.role === "user"));
  assert.ok(received.some((p) => p.type === "message.part.delta" && p.properties.delta === "All "));
  assert.ok(received.some((p) => p.type === "message.part.delta" && p.properties.delta === "good."));
  assert.ok(received.some((p) => p.type === "permission.asked" && p.properties.permission === "bash"));
  assert.ok(received.some((p) => p.type === "question.asked" && p.properties.questions[0].question === "Mode?"));
});

test("browser bundle resolves V2 tabs, WordBoundary heard text, and V2 composer selectors", () => {
  const heardFromBoundaries = extract("heardFromBoundaries");
  const boundaries = [
    { offsetMs: 100, durationMs: 200, text: "Je" },
    { offsetMs: 320, durationMs: 250, text: "relance" },
    { offsetMs: 600, durationMs: 250, text: "les" },
    { offsetMs: 850, durationMs: 300, text: "tests" },
  ];
  assert.equal(heardFromBoundaries(boundaries, 50), "");
  assert.equal(heardFromBoundaries(boundaries, 400), "Je relance");
  assert.equal(heardFromBoundaries(boundaries, 900), "Je relance les tests");

  const directoryFromV2Tabs = extract(
    "directoryFromV2Tabs",
    'const TABS_KEY="opencode.window.browser.dat:tabs";const TABS_INFO_KEY="opencode.window.browser.dat:tabs.info";const TABS_RECENT_KEY="opencode.window.browser.dat:tabs.recent";function sessionIdFromLocation(){return "ses_1";}',
  );
  const resolveSessionTargetUrl = extract(
    "resolveSessionTargetUrl",
    'const TABS_KEY="opencode.window.browser.dat:tabs";const TABS_INFO_KEY="opencode.window.browser.dat:tabs.info";',
  );
  const origin = "https://host.ts.net:1443";
  const pathname = "/server/abc/session/ses_1";
  globalThis.location = { origin, pathname };
  globalThis.localStorage = {
    getItem(k) {
      if (k === "opencode.window.browser.dat:tabs.info") {
        return JSON.stringify({ [`${origin}\n${pathname}`]: { directory: "/home/dev/repo" } });
      }
      if (k === "opencode.window.browser.dat:tabs") return "[]";
      return null;
    },
  };
  try {
    assert.equal(directoryFromV2Tabs("ses_1", pathname, origin), "/home/dev/repo");
    assert.equal(resolveSessionTargetUrl("ses_new", "/fallback"), "/server/abc/session/ses_new");
  } finally {
    delete globalThis.location;
    delete globalThis.localStorage;
  }

  assert.match(bundle, /composer-actions/);
  assert.match(bundle, /AudioWorkletNode/);
  assert.match(bundle, /x-tts-boundaries/);
  assert.match(bundle, /setLoopbackActive/);
  assert.match(bundle, /phrases-not-supported/);
});

test("Registry auto-loads Hex vocabulary terms and merges with learned aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "ows-hex-"));
  try {
    const hexPath = join(dir, "hex-settings.json");
    writeFileSync(
      hexPath,
      JSON.stringify({
        vocabulary: [
          { term: "KpihX", sounds_like: ["kpi hx", "kapoi va"] },
          { term: "Ollaya", sounds_like: ["oh la ya"] },
        ],
      }),
    );
    const reg = new Registry(dir, 50, hexPath);
    reg.learn("l e m", "LLM", false);
    const aliases = reg.aliases();
    assert.ok(aliases.some((a) => a.heard === "kpi hx" && a.canonical === "KpihX"));
    assert.ok(aliases.some((a) => a.heard === "oh la ya" && a.canonical === "Ollaya"));
    assert.ok(aliases.some((a) => a.heard === "l e m" && a.canonical === "LLM"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StreamerSession inherits main session model when streamer.model is empty", async () => {
  const createdBodies = [];
  const fakeClient = {
    async createSession(_dir, body) {
      createdBodies.push(body);
      return { id: "ses_str", title: body.title, directory: "/repo", version: "2", time: { created: 1, updated: 1 } };
    },
    async getSession() {
      return { id: "ses_str", title: "s", directory: "/repo", agent: "streamer", version: "2", time: { created: 1, updated: 1 } };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "ows-str-"));
  try {
    const reg = new Registry(dir, 50, join(dir, "no-hex.json"));
    const ss = new StreamerSession(
      "ses_main",
      "/repo",
      "Main",
      fakeClient,
      reg,
      { agent: "streamer", model: "", mainModel: { providerID: "custom", modelID: "fast-model" }, summarizeEveryPrompts: 80 },
      log,
      { onStreamerID() {} },
    );
    await ss.ensure();
    assert.deepEqual(createdBodies[0].model, { providerID: "custom", modelID: "fast-model" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DecisionEngine detects answer_from_context when results are already on screen", async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify({
        answers: {
          intent: { type: "choice", choice: "pass", probabilities: { stop: 0.05, noise: 0.05, pass: 0.9 } },
          from_context: { type: "noul", noul: 0.84 },
        },
      }),
      { status: 200 },
    );
  };
  const engine = new DecisionEngine(DEFAULTS.decision, log, fakeFetch);
  assert.equal(
    await engine.triageVoice("Présente uniquement la partie LLM", { speaking: false, busy: false, hasScreenAnswer: true }),
    "answer_from_context",
  );
});

test("loadConfig parses JSONC comments and trailing commas including streamer.models", () => {
  const dir = mkdtempSync(join(tmpdir(), "ows-cfg-"));
  try {
    const file = join(dir, "config.jsonc");
    writeFileSync(
      file,
      `// JSONC comment\n{\n  /* block comment */\n  "streamer": {\n    "models": ["p1/m1", "p2/m2",],\n  },\n}\n`,
    );
    const cfg = loadConfig({}, file);
    assert.deepEqual(cfg.streamer.models, ["p1/m1", "p2/m2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StreamerSession tries configured streamer.models in order when one fails", async () => {
  const tried = [];
  const fakeClient = {
    async createSession(_dir, body) {
      return { id: "ses_str", title: body.title, directory: "/repo", agent: "streamer", version: "2", time: { created: 1, updated: 1 } };
    },
    async getSession() {
      return { id: "ses_str", title: "s", directory: "/repo", agent: "streamer", version: "2", time: { created: 1, updated: 1 } };
    },
    async setSessionModel() {},
    async prompt(_sid, _dir, body) {
      tried.push(`${body.model.providerID}/${body.model.modelID}`);
      if (body.model.modelID === "bad-first") throw new Error("provider overloaded");
      return { info: { id: "m1", sessionID: "ses_str", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ id: "p1", sessionID: "ses_str", messageID: "m1", type: "text", text: "<reply>Ok!</reply>" }] };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "ows-order-"));
  try {
    const reg = new Registry(dir, 50, join(dir, "no-hex.json"));
    const ss = new StreamerSession(
      "ses_main",
      "/repo",
      "Main",
      fakeClient,
      reg,
      { agent: "streamer", model: "", models: ["p1/bad-first", "p2/good-second"], summarizeEveryPrompts: 80 },
      log,
      { onStreamerID() {} },
    );
    const res = await ss.ask("voice", "salut", 5000);
    assert.deepEqual(tried, ["p1/bad-first", "p2/good-second"]);
    assert.equal(res?.text, "<reply>Ok!</reply>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isEchoOfSpoken catches contiguous and high-overlap TTS echo snippets without blocking user questions", () => {
  const now = Date.now();
  const recent = [{ text: "Voici la synthèse des avancées technologiques sur cette recherche.", at: now - 1200 }];
  assert.equal(isEchoOfSpoken("la synthèse des avancées technologiques", recent, recent[0].text, now), true);
  assert.equal(isEchoOfSpoken("Voici la synthese des avancees", recent, recent[0].text, now), true);
  assert.equal(isEchoOfSpoken("Où en est la recherche ?", recent, recent[0].text, now), false);
  assert.equal(isEchoOfSpoken("ouvre le fichier config", recent, recent[0].text, now), false);
});

test("SttEngine toggles dynamically between hex local and browser online", async () => {
  const stt = new SttEngine({ ...DEFAULTS.stt, mode: "hex" }, log);
  assert.equal(stt.mode, "hex");
  assert.equal(await stt.check(true), true);
  assert.equal(stt.describe().engine, "hex");
  stt.setMode("browser");
  assert.equal(await stt.check(true), false);
  assert.equal(stt.describe().engine, "browser");
});

test("DecisionEngine never triggers stop on multi-word commands or when silent", async () => {
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/v1/models")) return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify({
        answers: {
          intent: { type: "choice", choice: "stop", probabilities: { stop: 0.45, noise: 0.15, pass: 0.4 } },
        },
      }),
      { status: 200 },
    );
  };
  const engine = new DecisionEngine(DEFAULTS.decision, log, fakeFetch);
  // Multi-word instruction mentioning "te taire" must pass through to streamer.
  assert.equal(
    await engine.triageVoice("Je te demande de ne pas te taire et faire la recherche", { speaking: true, busy: false }),
    "pass",
  );
  // Short command when NOT speaking must not stop silently.
  assert.equal(await engine.triageVoice("stop", { speaking: false, busy: false }), "pass");
});

test("encodeWav16k builds a valid 16 kHz mono RIFF WAV blob", async () => {
  const encodeWav16k = extract("encodeWav16k");
  const frame = new Float32Array(1536).fill(0.1);
  const blob = encodeWav16k([frame], 48000);
  assert.equal(blob.type, "audio/wav");
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(buf.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(buf.readUInt32LE(24), 16000);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.length, 44 + 512 * 2);
});

test("VoicePlayer preserves pausedItem on interrupt so resume continues without dropping mid-sentence", () => {
  assert.match(bundle, /pausedItem/);
  assert.match(bundle, /resumeOffsetSec/);
  assert.match(bundle, /max-height:\s*84px/);
  assert.match(bundle, /using daemon transcription \+ browser live interim/);
});

test("SttEngine treats Hex no-speech JSON exit as empty transcript and keeps Hex ready", async () => {
  const { mkdtempSync: mkd, writeFileSync: wf, chmodSync: chm, rmSync: rm } = await import("node:fs");
  const dir = mkd(join(tmpdir(), "ows-hex-ns-"));
  const fakeHex = join(dir, "hex");
  try {
    wf(
      fakeHex,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("hex 3.5.0"); process.exit(0); }
console.log(JSON.stringify({ version: 4, status: "error", code: "no-speech", message: "no speech" }));
process.exit(1);
`,
    );
    chm(fakeHex, 0o755);
    const stt = new SttEngine({ ...DEFAULTS.stt, mode: "hex", binary: fakeHex }, log);
    assert.equal(await stt.check(true), true);
    const out = await stt.transcribe(Buffer.alloc(1024, 1), { mime: "audio/wav" });
    assert.equal(out.text, "");
    assert.equal(stt.isReady, true);
  } finally {
    rm(dir, { recursive: true, force: true });
  }
});
