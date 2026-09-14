import test from "node:test";
import assert from "node:assert/strict";
import { BeatWindow, condenseInput, excerpt, renderBeat } from "../../dist/daemon/core/beats.js";

function toolPart(tool, overrides = {}) {
  return {
    id: overrides.id ?? `prt_${tool}_${Math.random().toString(36).slice(2, 6)}`,
    sessionID: "ses_main",
    messageID: "msg_1",
    type: "tool",
    tool,
    callID: overrides.callID ?? `call_${Math.random().toString(36).slice(2, 8)}`,
    state: {
      status: "completed",
      input: overrides.input ?? {},
      output: overrides.output ?? "ok",
      title: overrides.title ?? tool,
      metadata: {},
      time: { start: 1000, end: 1200 },
      ...overrides.state,
    },
  };
}

function harness(options = {}) {
  const flushed = [];
  let now = 0;
  const timers = [];
  const window = new BeatWindow(
    "ses_main",
    {
      windowMs: options.windowMs ?? 2500,
      maxTools: options.maxTools ?? 6,
      inputChars: 200,
      outputChars: 200,
      now: () => now,
      setTimer: (fn, ms) => {
        const handle = { fn, at: now + ms, cancelled: false };
        timers.push(handle);
        return handle;
      },
      clearTimer: (handle) => {
        handle.cancelled = true;
      },
    },
    (beat) => flushed.push(beat),
  );
  return {
    window,
    flushed,
    advance(ms) {
      now += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= now) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
  };
}

test("a window closes on time and carries every tool it collected", () => {
  const h = harness({ windowMs: 2500 });
  h.window.add(toolPart("read", { input: { filePath: "/p/a.ts" } }));
  h.window.add(toolPart("read", { input: { filePath: "/p/b.ts" } }));
  assert.equal(h.flushed.length, 0);
  h.advance(2500);
  assert.equal(h.flushed.length, 1);
  assert.equal(h.flushed[0].tools.length, 2);
  assert.equal(h.flushed[0].reason, "time");
});

test("a window closes early once it is full", () => {
  const h = harness({ maxTools: 3 });
  for (let i = 0; i < 3; i++) h.window.add(toolPart("read", { input: { filePath: `/p/${i}.ts` } }));
  assert.equal(h.flushed.length, 1);
  assert.equal(h.flushed[0].reason, "size");
});

test("a phase change closes the window immediately", () => {
  const h = harness();
  h.window.add(toolPart("bash", { input: { command: "npm test" } }));
  h.window.flush("phase");
  assert.equal(h.flushed.length, 1);
  assert.equal(h.flushed[0].reason, "phase");
});

test("an empty window produces nothing", () => {
  const h = harness();
  assert.equal(h.window.flush("phase"), undefined);
  assert.equal(h.flushed.length, 0);
});

test("a repeated call id is recorded once", () => {
  const h = harness();
  const part = toolPart("read", { callID: "same", input: { filePath: "/p/a.ts" } });
  h.window.add(part);
  h.window.add(part);
  h.window.flush("phase");
  assert.equal(h.flushed[0].tools.length, 1);
});

test("tools still running are not part of a beat", () => {
  const h = harness();
  h.window.add(toolPart("bash", { state: { status: "running" } }));
  assert.equal(h.window.size, 0);
});

test("failures are marked so the streamer can react to them", () => {
  const h = harness();
  h.window.add(toolPart("bash", { state: { status: "error", error: "exit 1" }, input: { command: "npm test" } }));
  h.window.flush("phase");
  assert.equal(h.flushed[0].tools[0].status, "error");
  assert.match(h.flushed[0].tools[0].output, /exit 1/);
});

test("subagent tools are attributed", () => {
  const h = harness();
  h.window.add(toolPart("grep", { input: { pattern: "TODO" } }), "explore");
  h.window.flush("phase");
  assert.equal(h.flushed[0].tools[0].via, "explore");
  assert.match(renderBeat(h.flushed[0], { userPrompt: "", sessionTitle: "t" }), /via explore/);
});

test("arguments are condensed to what a narrator needs", () => {
  assert.equal(condenseInput("read", { filePath: "/a/b.ts", offset: 10, extra: "x" }, 200), "filePath=/a/b.ts offset=10");
  assert.equal(condenseInput("bash", { command: "npm test", timeout: 1 }, 200), "command=npm test");
  assert.equal(condenseInput("todowrite", { todos: [1, 2, 3] }, 200), "3 todos");
});

test("huge outputs are truncated before they reach the model", () => {
  const long = "x".repeat(5000);
  const trimmed = excerpt(long, 100);
  assert.equal(trimmed.length, 100);
  assert.ok(trimmed.endsWith("…"));
});

test("a rendered beat carries the task, the plan and the tools", () => {
  const h = harness();
  h.window.add(toolPart("read", { input: { filePath: "/p/server.ts" }, title: "server.ts" }));
  h.window.add(toolPart("bash", { input: { command: "npm test" }, output: "2 failed" }));
  h.window.flush("phase");
  const text = renderBeat(h.flushed[0], { userPrompt: "corrige le timeout", sessionTitle: "fix timeout", todo: "▶ corriger", elapsedSinceStartMs: 12000 });
  assert.match(text, /^\[BEAT\]/);
  assert.match(text, /prompt: corrige le timeout/);
  assert.match(text, /plan: ▶ corriger/);
  assert.match(text, /elapsed: 12s/);
  assert.match(text, /npm test/);
  assert.match(text, /2 failed/);
});

test("disposing cancels the pending timer", () => {
  const h = harness();
  h.window.add(toolPart("read"));
  h.window.dispose();
  h.advance(10000);
  assert.equal(h.flushed.length, 0);
});
