// hook.js — Unified Orchestrator Hook for OpenCode Web Stream
// Intercepts tool progress, batches them by semantic category, and queries
// the "streamer" sub-agent for intelligent orchestration (Speak or Silent).
// Also handles WRAP_UP final answer summaries.

import { appendFileSync } from "node:fs";

const DEFAULT_DAEMON_BASE = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 2500;
const DEFAULT_WEB_PORT = "40977";
const DEFAULT_MAX_OUTPUT_CHARS = 4000; // Increased to prevent truncation of WRAP_UP
const DEFAULT_NARRATOR_TIMEOUT_MS = 25000;

function resolveWebPort(options = {}) {
  return String(options?.webPort ?? process.env.OPENCODE_WEB_PORT ?? DEFAULT_WEB_PORT);
}

function resolveDaemonBase(options = {}) {
  return String(
    options?.daemonUrl ?? process.env.OPENCODE_WEB_STREAM_URL ?? DEFAULT_DAEMON_BASE
  ).replace(/\/+$/, "");
}

export function isWebMode(input = {}, options = {}) {
  if (options?.forceWeb === true) return true;
  if (options?.webOnly === false) return true;

  let port = "";
  try {
    const raw = input?.serverUrl ?? process.env.OPENCODE_SERVER_URL ?? "";
    if (!raw) return process.env.OPENCODE_WEB_FORCE === "1";
    const url = raw instanceof URL ? raw : new URL(String(raw));
    port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  } catch {
    return false;
  }
  return port === resolveWebPort(options);
}

function audit(line) {
  try {
    appendFileSync(
      "/tmp/opencode-web-stream-progress-audit.log",
      `${new Date().toISOString()} ${line}\n`
    );
  } catch {}
}

function parseModel(spec) {
  const raw = String(spec ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

function unwrap(result) {
  return result?.data ?? result;
}

function extractText(result) {
  const parts = unwrap(result)?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function facts(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("narrator timeout")), ms)),
  ]);
}

// ------------------------------------------------------------------
// STREAMER ORCHESTRATOR
// ------------------------------------------------------------------
function createStreamer({ client, directory, agent, model, timeoutMs, debug }) {
  const narratorOf = new Map();
  const owned = new Set();
  const chains = new Map();

  const log = (...args) => {
    if (debug) console.error("[opencode-web-stream-progress]", ...args);
  };

  async function sessionFor(sessionID) {
    const known = narratorOf.get(sessionID);
    if (known) return known;

    const res = unwrap(await client.session.create({ directory }));
    const nid = res.id;
    owned.add(nid);
    narratorOf.set(sessionID, nid);

    try {
      await client.session.postMessage({
        path: { id: nid },
        body: {
          message: "",
          overlay: { agent, model },
        },
      });
      log(`narrator session ${nid} bound to ${sessionID}`);
      
      // Notify daemon of the binding so it can route STT voice intercepts to the streamer
      postJson(`${resolveDaemonBase({ debug })}/api/agent/streamer_session`, {
        main_session: sessionID,
        streamer_session: nid
      });
    } catch (e) {
      log(`failed to configure narrator session ${nid} for ${sessionID}`, e);
    }
    return nid;
  }

  function serialize(sessionID, task) {
    const chain = chains.get(sessionID) ?? Promise.resolve();
    const next = chain.then(() => task().catch((e) => log(`task error session=${sessionID}`, e)));
    chains.set(sessionID, next);
  }

  async function speak(sessionID, prompt) {
    try {
      const nid = await sessionFor(sessionID);
      const res = await withTimeout(
        client.session.postMessage({
          path: { id: nid },
          body: { message: prompt },
        }),
        timeoutMs
      );
      return extractText(res);
    } catch (e) {
      log(`speak failed session=${sessionID}`, e);
      return "";
    }
  }

  return { isOwned: (sid) => owned.has(sid), serialize, speak };
}

// ------------------------------------------------------------------
// BATCHING ENGINE
// ------------------------------------------------------------------
const CATEGORY_MAP = {
  read: "EXPLORE", ast: "EXPLORE", ast_outline: "EXPLORE", glob: "EXPLORE", grep: "EXPLORE",
  edit: "PATCH", write: "PATCH",
  bash: "SHELL", ssh: "SHELL",
  exa_web_search_exa: "SEARCH", exa_web_fetch_exa: "SEARCH", webfetch: "SEARCH"
};

function getCategory(tool) {
  return CATEGORY_MAP[tool] || "MISC";
}

async function postJson(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (e.name !== "TimeoutError") {
      audit(`postJson error url=${url} msg=${e.message}`);
    }
  }
}

async function turnDigest(client, directory, sessionID, maxChars = 4000) {
  try {
    const raw = unwrap(
      await client.session.messages({
        path: { id: sessionID },
        query: { directory, limit: 12 },
      })
    );
    const list = Array.isArray(raw) ? raw : raw?.messages ?? [];
    let userText = "";
    let assistantText = "";
    for (const m of list) {
      const role = m?.info?.role ?? m?.role;
      const parts = m?.parts ?? [];
      const text = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text.trim())
        .filter(Boolean)
        .join(" ");
      if (!text) continue;
      if (role === "user") userText = text;
      if (role === "assistant") assistantText = text;
    }
    return {
      user: userText.slice(0, maxChars),
      assistant: assistantText.slice(0, maxChars),
      hasAssistant: assistantText.length > 0,
    };
  } catch (e) {
    audit(`turnDigest failed session=${sessionID} msg=${e.message}`);
    return { user: "", assistant: "", hasAssistant: false };
  }
}

// ------------------------------------------------------------------
// PLUGIN EXPORT
// ------------------------------------------------------------------
export default function plugin(input, options) {
  if (!isWebMode(input, options)) {
    audit(`inert: not web mode serverUrl=${input?.serverUrl}`);
    return {};
  }
  const agent = String(options?.agent ?? "streamer");
  if (!parseModel(options?.model) || !input?.client) {
    audit(`inert: missing agent/model/client agent=${agent} model=${options?.model}`);
    return {};
  }

  const daemon = resolveDaemonBase(options);
  const maxOutputChars = Number(options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const debug = options?.debug === true || process.env.OPENCODE_WEB_STREAM_DEBUG === "1";
  const client = input.client;
  const directory = input.directory ?? process.cwd();
  
  const streamer = createStreamer({
    client,
    directory,
    agent,
    model: options.model,
    timeoutMs: Number(options?.narratorTimeoutMs ?? DEFAULT_NARRATOR_TIMEOUT_MS),
    debug,
  });

  // State
  const trajectory = new Map(); // sessionID -> { steps, errors }
  const activeBatches = new Map(); // sessionID -> { category, tools: [] }

  function flushBatch(sessionID) {
    const batch = activeBatches.get(sessionID);
    if (!batch || batch.tools.length === 0) return;
    activeBatches.delete(sessionID);

    const prompt = `[TOOL_BATCH]\nCategory: ${batch.category}\nTools executed:\n` +
      batch.tools.map(t => `- ${t.tool}: ${t.title} (${t.status})`).join("\n");

    streamer.serialize(sessionID, async () => {
      const response = await streamer.speak(sessionID, prompt);
      let summary = "";
      if (response && response.includes("<SPEAK>")) {
        summary = response.split("<SPEAK>")[1]?.trim() || "";
      }

      // We still post the progress to the daemon for the UI, 
      // but if summary is "", it stays silent. We send the last tool's info as the UI anchor.
      const lastTool = batch.tools[batch.tools.length - 1];
      audit(`BATCH FLUSH session=${sessionID} cat=${batch.category} speak=${!!summary}`);
      postJson(`${daemon}/api/agent/progress`, {
        step_id: lastTool.callID,
        title: `[${batch.category}] ${batch.tools.length} actions`,
        tool: lastTool.tool,
        tool_input: lastTool.args,
        model: options.model,
        agent,
        summary: summary,
        full_detail: null,
        status: "completed",
      });
    });
  }

  return {
    tool: async ({ event }) => {
      if (event?.type !== "tool.after") return;
      const sessionID = event?.properties?.sessionID;
      if (!sessionID || streamer.isOwned(sessionID)) return;

      const callID = event.properties?.callID;
      const tool = event.properties?.tool?.name;
      if (!callID || !tool) return;

      const status = event.properties?.status;
      const seen = trajectory.get(sessionID) ?? { steps: 0, errors: 0 };
      seen.steps += 1;
      if (status === "error") seen.errors += 1;
      trajectory.set(sessionID, seen);

      const category = getCategory(tool);
      const currentBatch = activeBatches.get(sessionID);

      const toolData = {
        callID, tool, args: event.properties?.tool?.args, status, 
        title: event.properties?.output?.title || tool
      };

      if (!currentBatch) {
        activeBatches.set(sessionID, { category, tools: [toolData] });
      } else if (currentBatch.category === category) {
        currentBatch.tools.push(toolData);
      } else {
        // Category changed! Flush old batch, start new one.
        flushBatch(sessionID);
        activeBatches.set(sessionID, { category, tools: [toolData] });
      }
    },

    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const sessionID = event?.properties?.sessionID;
      if (!sessionID || streamer.isOwned(sessionID)) return;

      // 1. Flush any remaining tool batch
      flushBatch(sessionID);

      const seen = trajectory.get(sessionID) ?? { steps: 0, errors: 0 };
      trajectory.delete(sessionID);

      const digest = await turnDigest(client, directory, sessionID, maxOutputChars);
      if (seen.steps === 0 && !digest.hasAssistant) {
        return;
      }

      // Pure Q&A bypasses tools entirely. 
      if (seen.steps === 0 && digest.hasAssistant) {
        const replyPrompt = `[WRAP_UP]\n${facts({ answer: digest.assistant, user: digest.user })}`;
        streamer.serialize(sessionID, async () => {
          const response = await streamer.speak(sessionID, replyPrompt);
          let summary = "";
          if (response && response.includes("<SPEAK>")) {
            summary = response.split("<SPEAK>")[1]?.trim() || "";
          }
          postJson(`${daemon}/api/agent/progress`, {
            step_id: `reply_${sessionID}_${Date.now()}`,
            title: "assistant reply",
            tool: "reply",
            tool_input: { user: digest.user },
            model: options.model,
            agent,
            summary: summary,
            full_detail: digest.assistant,
            status: "completed",
          });
        });
        return;
      }

      const prompt = `[WRAP_UP]\n${facts({
        answer: digest.assistant || undefined,
        user: digest.user || undefined,
        session: sessionID,
        steps: seen.steps,
        errors: seen.errors,
      })}`;

      streamer.serialize(sessionID, async () => {
        const response = await streamer.speak(sessionID, prompt);
        let summary = "";
        if (response && response.includes("<SPEAK>")) {
          summary = response.split("<SPEAK>")[1]?.trim() || "";
        }
        
        postJson(`${daemon}/api/agent/summary`, {
          session_id: sessionID,
          model: options.model,
          agent,
          summary_text: summary,
        });
      });
    },
  };
}
