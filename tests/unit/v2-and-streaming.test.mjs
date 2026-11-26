import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../../dist/daemon/config.js";
import { OpencodeClient } from "../../dist/daemon/opencode/client.js";
import { DecisionEngine } from "../../dist/daemon/engines/decision.js";
import { normalizeEdgeVoice, generateSecMsGecV2 } from "../../dist/daemon/engines/edge-tts.js";
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
  assert.equal(normalizeEdgeVoice("ff_siwis", "fr"), "fr-FR-VivienneMultilingualNeural");
  assert.equal(normalizeEdgeVoice("af_heart", "en-US"), "en-US-EmmaMultilingualNeural");
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

test("DecisionEngine parses local qwen3 JSON responses and strips think tags", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    if (String(url).endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen3-0.6b" }] }), { status: 200 });
    }
    seen.push(JSON.parse(init.body));
    const userMsg = seen.at(-1).messages[1].content;
    if (userMsg.includes("tais-toi")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "<think>fast</think>{\"intent\":\"stop\"}" } }] }), { status: 200 });
    }
    if (userMsg.includes("euh")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"intent\":\"noise\"}" } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"speak\":false}" } }] }), { status: 200 });
  };

  const engine = new DecisionEngine(DEFAULTS.decision, log, fakeFetch);
  assert.equal(await engine.check(true), true);
  assert.equal(await engine.triageVoice("tais-toi", { speaking: true, busy: false }), "stop");
  assert.equal(await engine.triageVoice("euh", { speaking: true, busy: false }), "noise");
  assert.equal(await engine.triageBeat("read file foo.ts"), false);
  assert.equal(seen[0].chat_template_kwargs.enable_thinking, false);
});

test("DecisionEngine degrades to pass/true when local OpenVINO is offline", async () => {
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
});
