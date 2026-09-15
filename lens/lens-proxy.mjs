#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { connect as connectTls } from "node:tls";

const cwd = process.cwd();
const target = process.env.OPENCODE_TARGET || "http://127.0.0.1:5050";
const port = parseInt(process.env.PORT || "3000", 10);
const configPath = process.env.LENS_CONFIG || "lens.config.json";
const statePath = process.env.LENS_STATE || ".lens-state.json";
// opencode-web-stream daemon: HTTP under /__stream__/ and WebSocket at /ws/stream
// are bridged to it. One place to change if it ever moves off 8765.
const streamTarget = new URL(process.env.OPENCODE_WEB_STREAM_TARGET || "http://127.0.0.1:8765");
const streamHost = streamTarget.hostname;
const streamPort = parseInt(streamTarget.port || "80", 10);
const pluginSpecs = readPluginSpecs();
const plugins = pluginSpecs.map(normalizePluginSpec).map(loadPlugin);
const state = readState();

if (plugins.length === 0) {
  console.warn(
    "Lens started with no plugins. Set OPENCODE_WEB_PLUGINS or create lens.config.json.",
  );
}

const targetUrl = new URL(target);
if (!["http:", "https:"].includes(targetUrl.protocol)) {
  throw new Error("OPENCODE_TARGET must use the http or https protocol.");
}
const targetHost = targetUrl.hostname;
const targetPort = parseInt(targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80"), 10);
const proxyRequest = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
const INJECT_HEAD = "</head>";
const INJECT_BODY = "</body>";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

const server = createServer(async (clientReq, clientRes) => {
  if (clientReq.url?.startsWith("/__lens/")) {
    await handleLensRequest(clientReq, clientRes);
    return;
  }

  // Reverse-proxy /__stream__/ HTTP routes directly to the opencode-web-stream daemon
  // Transparent bridge regardless of public URL (localhost, LAN, Tailscale, Reverse Proxy)
  if (clientReq.url?.startsWith("/__stream__/")) {
    const streamTargetUrl = clientReq.url.replace(/^\/__stream__/, "") || "/";
    const streamReq = httpRequest(
      {
        hostname: streamHost,
        port: streamPort,
        path: streamTargetUrl,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: `${streamHost}:${streamPort}`,
        },
      },
      (streamRes) => {
        clientRes.writeHead(streamRes.statusCode ?? 200, streamRes.headers);
        streamRes.pipe(clientRes);
      }
    );
    streamReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ error: "Stream daemon unavailable", detail: String(err) }));
      }
    });
    clientReq.pipe(streamReq);
    return;
  }

  const headers = { ...clientReq.headers };
  delete headers["accept-encoding"];

  // HOST HEADER FIX (found + fixed 2026-08-17, same bug class as the
  // opencode-web terminal-url-shim fix, reproduced independently in this
  // vendored third-party proxy on a SEPARATE hop): this used to
  // unconditionally `delete headers.host`, which made Node's http.request()
  // auto-set Host to the real backend's own address (targetHost:targetPort,
  // e.g. "127.0.0.1:40977") instead of the original client-facing hostname.
  // opencode's backend does an Origin/Host same-origin check on
  // POST /pty/{id}/connect-token (`iI(origin, host, corsConfig)` in the
  // compiled opencode binary) — with Origin left as the real Tailscale
  // hostname the browser sent but Host rewritten to the internal backend
  // address, the two never match and the backend returns
  // 403 PtyForbiddenError("Invalid PTY connect token request"). Reproduced
  // exactly via curl (Origin=tailscale lens hostname + Host deleted → 403).
  // Fix: do NOT delete Host — let the original client-facing Host header
  // (already present in clientReq.headers, spread into `headers` above)
  // pass through unchanged, so Origin and Host naturally match for real
  // browser requests. This does not break routing: `proxyRequest(...)`
  // below already connects to the correct internal address via the
  // explicit `hostname`/`port` options, not via this header.

  const proxyReq = proxyRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (proxyRes) => {
      const contentType = proxyRes.headers["content-type"] || "";
      const isHtml = String(contentType).includes("text/html");

      if (!isHtml || proxyRes.statusCode !== 200) {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }

      const chunks = [];
      proxyRes.on("data", (chunk) => {
        chunks.push(chunk);
      });
      proxyRes.on("end", () => {
        let body = inject(Buffer.concat(chunks).toString("utf8"), getEnabledInjections());

        // Dynamically rename the tab to distinctly identify the Lens injected version
        body = body.replace(/<title>[^<]*<\/title>/i, "<title>K-Opencode</title>");

        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders["content-length"];
        delete responseHeaders["transfer-encoding"];
        delete responseHeaders["content-security-policy"];
        delete responseHeaders["content-security-policy-report-only"];
        responseHeaders["content-length"] = String(Buffer.byteLength(body, "utf8"));

        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);
        clientRes.end(body);
      });
    },
  );

  proxyReq.on("error", () => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end("Lens proxy error");
    }
  });

  clientReq.pipe(proxyReq);
});

server.on("upgrade", (clientReq, clientSocket, clientHead) => {
  // Check if WebSocket upgrade targets the stream daemon (/ws/stream or /__stream__/ws/stream)
  const isStreamWs = clientReq.url?.startsWith("/__stream__/") || clientReq.url?.startsWith("/ws/stream");
  const actualTargetHost = isStreamWs ? streamHost : targetHost;
  const actualTargetPort = isStreamWs ? streamPort : targetPort;
  const actualTargetUrlPath = isStreamWs ? clientReq.url.replace(/^\/__stream__/, "") : clientReq.url;

  const connectToTarget = (!isStreamWs && targetUrl.protocol === "https:") ? connectTls : connect;
  const proxySocket = connectToTarget(
    (!isStreamWs && targetUrl.protocol === "https:")
      ? { host: actualTargetHost, port: actualTargetPort, servername: actualTargetHost }
      : { host: actualTargetHost, port: actualTargetPort },
    () => {
      const hostHeader = isStreamWs ? `${streamHost}:${streamPort}` : targetUrl.host;
      const lines = [
        `${clientReq.method} ${actualTargetUrlPath} HTTP/${clientReq.httpVersion}`,
        `Host: ${hostHeader}`,
        "Connection: Upgrade",
        ...Object.entries(clientReq.headers)
          .filter(([key]) => !["host", "connection", "upgrade"].includes(key.toLowerCase()))
          .map(([key, value]) => `${key}: ${value}`),
        "Upgrade: websocket",
        "",
        "",
      ];

      proxySocket.write(lines.join("\r\n"));
      proxySocket.write(clientHead);

      clientSocket.pipe(proxySocket);
      proxySocket.pipe(clientSocket);
    },
  );

  proxySocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => proxySocket.destroy());
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lens ready: http://127.0.0.1:${port} -> ${target}`);
  console.log(`Registered ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}.`);
});

function readPluginSpecs() {
  const fromEnv = process.env.OPENCODE_WEB_PLUGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (fromEnv?.length) return fromEnv;

  const resolvedConfig = resolve(cwd, configPath);
  if (!existsSync(resolvedConfig)) return [];

  const config = JSON.parse(readFileSync(resolvedConfig, "utf8"));
  if (!Array.isArray(config.plugins)) {
    throw new Error(`${configPath} must contain a plugins array.`);
  }

  return config.plugins;
}

function normalizePluginSpec(spec) {
  if (typeof spec === "string") return { source: spec };

  if (!spec || typeof spec !== "object") {
    throw new Error("Plugin entries must be strings or objects.");
  }

  return { ...spec, source: spec.path || spec.url };
}

function loadPlugin(spec) {
  const loaded = spec.source
    ? spec.source.startsWith("http://") || spec.source.startsWith("https://")
      ? remotePlugin(spec)
      : loadLocalPlugin(spec.source, cwd)
    : manifestPlugin(spec, cwd);

  return {
    ...loaded,
    id: spec.id || loaded.id,
    name: spec.name || loaded.name,
    description: spec.description || loaded.description || "",
    enabledByDefault: spec.enabled !== false,
  };
}

function loadLocalPlugin(path, baseDir) {
  const resolved = resolvePath(path, baseDir);
  const contents = readFileSync(resolved, "utf8");

  if (resolved.endsWith(".json")) {
    return manifestPlugin(JSON.parse(contents), dirname(resolved), resolved);
  }

  return {
    id: slugify(path),
    name: readableName(path),
    description: "",
    source: path,
    html: `<script type="module">\n${contents}\n</script>`,
  };
}

function remotePlugin(plugin) {
  return {
    id: slugify(plugin.source),
    name: plugin.name || readableName(plugin.source),
    description: plugin.description || "",
    source: plugin.source,
    html: `<script type="module" src="${escapeAttribute(plugin.source)}"></script>`,
  };
}

function manifestPlugin(plugin, baseDir, source = "inline") {
  const name = plugin.name || readableName(source);
  const html = typeof plugin.html === "string" ? plugin.html : "";
  const script = plugin.script ? readFileSync(resolvePath(plugin.script, baseDir), "utf8") : "";

  return {
    id: plugin.id || slugify(name),
    name,
    description: plugin.description || "",
    source,
    html: `<!-- Lens plugin: ${escapeComment(name)} -->\n${html}\n${script ? `<script type="module">\n${script}\n</script>` : ""}`,
  };
}

function resolvePath(path, baseDir) {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function inject(body, injection) {
  if (!injection) return body;
  if (body.includes(INJECT_HEAD)) return body.replace(INJECT_HEAD, `${injection}${INJECT_HEAD}`);
  if (body.includes(INJECT_BODY)) return body.replace(INJECT_BODY, `${injection}${INJECT_BODY}`);
  return `${body}${injection}`;
}

function getEnabledInjections() {
  return [
    settingsPanelScript(),
    ...plugins.filter(isPluginEnabled).map((plugin) => plugin.html),
  ].join("\n");
}

function isPluginEnabled(plugin) {
  return state.plugins?.[plugin.id]?.enabled ?? plugin.enabledByDefault;
}

function readState() {
  const resolvedState = resolve(cwd, statePath);
  if (!existsSync(resolvedState)) return { plugins: {} };
  return JSON.parse(readFileSync(resolvedState, "utf8"));
}

function writeState() {
  writeFileSync(resolve(cwd, statePath), `${JSON.stringify(state, null, 2)}\n`);
}

async function handleLensRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (req.method === "GET" && url.pathname === "/__lens/plugins") {
    sendJson(res, {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        source: plugin.source,
        enabled: isPluginEnabled(plugin),
      })),
    });
    return;
  }

  const toggleMatch = url.pathname.match(/^\/__lens\/plugins\/([^/]+)$/);
  if (req.method === "POST" && toggleMatch) {
    let body;
    try {
      body = await readRequestBody(req);
    } catch (error) {
      const status = error.statusCode === 413 ? 413 : 400;
      sendJson(res, { error: error.message || "Request body could not be read" }, status);
      return;
    }

    const plugin = plugins.find((candidate) => candidate.id === decodeURIComponent(toggleMatch[1]));
    if (!plugin) {
      sendJson(res, { error: "Plugin not found" }, 404);
      return;
    }

    let update;
    try {
      update = JSON.parse(body || "{}");
    } catch {
      sendJson(res, { error: "Request body must be valid JSON" }, 400);
      return;
    }

    if (!update || typeof update !== "object" || typeof update.enabled !== "boolean") {
      sendJson(res, { error: "Request body must include a boolean enabled value" }, 400);
      return;
    }

    state.plugins ||= {};
    state.plugins[plugin.id] = { enabled: update.enabled };
    writeState();
    sendJson(res, { ok: true });
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

function readRequestBody(req) {
  const contentLength = Number(req.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    req.resume();
    return Promise.reject(requestBodyTooLargeError());
  }

  return new Promise((resolveBody, reject) => {
    let body = "";
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;

      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        req.resume();
        reject(requestBodyTooLargeError());
        return;
      }

      body += chunk.toString("utf8");
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function requestBodyTooLargeError() {
  const error = new Error(`Request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes`);
  error.statusCode = 413;
  return error;
}

function sendJson(res, body, status = 200) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(json, "utf8")),
  });
  res.end(json);
}

function settingsPanelScript() {
  return `<script type="module">\n${LENS_SETTINGS_CLIENT}\n</script>`;
}

function slugify(value) {
  return (
    String(value)
      .replace(/^https?:\/\//, "")
      .replace(/\.[cm]?js(on)?$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "plugin"
  );
}

function readableName(value) {
  const path = String(value);
  const file = basename(path).replace(/\.[cm]?js(on)?$/i, "");
  const parent = basename(dirname(path));
  const name = ["index", "plugin", "client"].includes(file)
    ? parent === "dist"
      ? basename(dirname(dirname(path)))
      : parent
    : file;
  return name || "Plugin";
}

function escapeAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeComment(value) {
  return String(value).replaceAll("--", "-");
}

const LENS_SETTINGS_CLIENT = `(${function lensSettingsClient() {
  const STATE_KEY = "__opencodeLensSettings";
  const lensWindow = window;

  lensWindow[STATE_KEY]?.cleanup?.();

  const observer = new MutationObserver(attachLensSettings);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachLensSettings();

  lensWindow[STATE_KEY] = {
    cleanup() {
      observer.disconnect();
      document.querySelectorAll("[data-lens-settings]").forEach((element) => element.remove());
    },
  };

  function attachLensSettings() {
    const modal = findSettingsModal();
    if (!modal) return;

    const sidebar = findSettingsSidebar(modal);
    const content = findSettingsContent(modal, sidebar);
    if (!sidebar || !content) return;

    if (!modal.querySelector('[data-lens-settings="category"]')) {
      insertLensCategory(sidebar, createLensCategory(sidebar, content));
    }

    if (content.querySelector('[data-lens-settings="panel"]')) return;

    const section = document.createElement("section");
    section.dataset.lensSettings = "panel";
    section.hidden = true;
    section.tabIndex = -1;
    section.innerHTML = `
    <style>
      [data-lens-settings="category"] {
        margin-top: 0;
      }
      [data-lens-settings="category-label"] {
        pointer-events: none;
      }
      [data-lens-settings="nav"] {
        cursor: pointer;
      }
      [data-lens-settings="panel"] {
        display: grid;
        align-content: start;
        gap: 20px;
        box-sizing: border-box;
        min-height: 100%;
        padding: 16px 18px;
      }
      [data-lens-settings="panel"][hidden] {
        display: none !important;
      }
      [data-lens-settings="header"] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      [data-lens-settings="title"] {
        margin: 0;
        font: 600 18px/1.2 system-ui, sans-serif;
      }
      [data-lens-settings="hint"] {
        display: none;
        margin: 0;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.4 system-ui, sans-serif;
      }
      [data-lens-settings="list"] {
        display: grid;
        gap: 0;
      }
      [data-lens-settings="plugin"] {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        padding: 18px 0;
      }
      [data-lens-settings="plugin-copy"] {
        display: grid;
        min-width: 0;
      }
      [data-lens-settings="plugin-name"] {
        color: color-mix(in srgb, currentColor 92%, transparent);
        font: 600 15px/1.35 system-ui, sans-serif;
      }
      [data-lens-settings="plugin-source"] {
        display: none;
        max-width: 42ch;
        overflow: hidden;
        color: color-mix(in srgb, currentColor 58%, transparent);
        font: 11px/1.3 ui-monospace, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-lens-settings="plugin-description"] {
        margin-top: 4px;
        color: color-mix(in srgb, currentColor 54%, transparent);
        font: 14px/1.45 system-ui, sans-serif;
      }
      [data-lens-settings="toggle"] {
        position: relative;
        display: inline-flex;
        min-width: 38px;
        min-height: 22px;
        flex: 0 0 auto;
        align-items: center;
        margin-top: 2px;
      }
      [data-lens-settings="toggle"] input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      [data-lens-settings="toggle-track"] {
        width: 38px;
        height: 22px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, canvas 82%, currentColor 8%);
        transition: background 120ms ease;
      }
      [data-lens-settings="toggle-track"]::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 4px;
        background: color-mix(in srgb, currentColor 42%, transparent);
        box-shadow: none;
        transition: transform 120ms ease;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"] {
        background: color-mix(in srgb, currentColor 14%, transparent);
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"]::after {
        transform: translateX(16px);
      }
      [data-lens-settings="reload"] {
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: 999px;
        padding: 6px 10px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: 12px/1 system-ui, sans-serif;
      }
    </style>
    <div data-lens-settings="header">
      <h2 data-lens-settings="title">Plugins</h2>
      <button type="button" data-lens-settings="reload">Reload UI</button>
    </div>
    <p data-lens-settings="hint">Enable or disable plugins, then reload OpenCode Web to apply the current set.</p>
    <div data-lens-settings="list">Loading plugins...</div>
  `;

    content.appendChild(section);
    section
      .querySelector('[data-lens-settings="reload"]')
      ?.addEventListener("click", () => location.reload());

    sidebar.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest('[data-lens-settings="nav"]')) {
          return;
        }

        restoreSettingsPanel(content);
        setLensSelected(sidebar, false);
      },
      true,
    );

    modal.addEventListener(
      "click",
      (event) => {
        if (event.target instanceof Element && event.target.closest("[data-lens-settings]")) {
          return;
        }

        restoreSettingsPanel(content);
        setLensSelected(sidebar, false);
      },
      true,
    );

    renderPluginList(section);
  }

  function findSettingsModal() {
    const candidates = Array.from(
      document.querySelectorAll('dialog,[role="dialog"],[data-state="open"],.modal'),
    );
    return candidates.find((candidate) => {
      const text = candidate.textContent || "";
      return /General/i.test(text) && /Shortcuts/i.test(text) && /Providers/i.test(text);
    });
  }

  function findSettingsSidebar(modal) {
    const buttons = ["General", "Shortcuts", "Servers", "Providers", "Models"].map((label) =>
      findButtonByText(modal, label),
    );
    if (buttons.some((button) => !button)) return;

    let current = buttons[0].parentElement;
    while (current && current !== modal) {
      if (buttons.every((button) => current.contains(button))) {
        const rect = current.getBoundingClientRect();
        const modalRect = modal.getBoundingClientRect();
        if (rect.width < modalRect.width * 0.6) return current;
      }
      current = current.parentElement;
    }
  }

  function findSettingsContent(modal, sidebar) {
    if (!sidebar) return;

    const sidebarRect = sidebar?.getBoundingClientRect();
    const candidates = Array.from(modal.querySelectorAll("div,main,section")).filter(
      (candidate) => !sidebar.contains(candidate) && !candidate.contains(sidebar),
    );

    return candidates
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const text = candidate.textContent || "";
        return (
          rect.left >= sidebarRect.right - 2 &&
          rect.width > sidebarRect.width * 0.8 &&
          rect.height > sidebarRect.height * 0.45 &&
          !/Desktop\s+General\s+Shortcuts/i.test(text)
        );
      })
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return aRect.left - bRect.left || bRect.width * bRect.height - aRect.width * aRect.height;
      })[0];
  }

  function createLensCategory(sidebar, content) {
    const category = cloneCategoryContainer(sidebar);
    category.dataset.lensSettings = "category";

    const label = cloneCategoryLabel(sidebar);
    label.dataset.lensSettings = "category-label";
    label.textContent = "Lens";

    const button = cloneNavButton(sidebar);
    button.type = "button";
    button.dataset.lensSettings = "nav";
    setPuzzleIcon(button);
    replaceButtonLabel(button, "Plugins");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentModal = findSettingsModal();
      const currentSidebar = currentModal ? findSettingsSidebar(currentModal) : sidebar;
      const currentContent = currentModal
        ? findSettingsContent(currentModal, currentSidebar)
        : content;
      if (!currentSidebar || !currentContent) return;

      ensureLensPanel(currentContent);
      showLensPanel(currentSidebar, currentContent, button);
    });

    category.append(label, button);
    return category;
  }

  function insertLensCategory(sidebar, category) {
    const footer = Array.from(sidebar.children).find((candidate) =>
      /OpenCode Desktop/i.test(candidate.textContent || ""),
    );

    sidebar.insertBefore(category, footer || null);
  }

  function cloneCategoryContainer(sidebar) {
    const serverLabel = Array.from(sidebar.querySelectorAll("div,span,p,h2,h3,h4")).find(
      (candidate) => /^(Server|Desktop)$/i.test((candidate.textContent || "").trim()),
    );
    const container = serverLabel?.parentElement?.cloneNode(false);
    return container instanceof HTMLElement ? container : document.createElement("div");
  }

  function cloneCategoryLabel(sidebar) {
    const match = Array.from(sidebar.querySelectorAll("div,span,p,h2,h3,h4")).find((candidate) =>
      /^(Server|Desktop)$/i.test((candidate.textContent || "").trim()),
    );
    return match ? match.cloneNode(false) : document.createElement("div");
  }

  function cloneNavButton(sidebar) {
    const buttons = Array.from(sidebar.querySelectorAll("button"));
    const match =
      buttons.find(
        (candidate) =>
          /General|Shortcuts|Servers|Providers|Models/i.test(candidate.textContent || "") &&
          !isSelectedButton(candidate),
      ) ||
      buttons.find((candidate) =>
        /General|Shortcuts|Servers|Providers|Models/i.test(candidate.textContent || ""),
      );
    const button = match ? match.cloneNode(true) : document.createElement("button");
    if (button instanceof HTMLElement) {
      button.dataset.lensInactiveClass = button.className;
    }
    return button;
  }

  function replaceButtonLabel(button, label) {
    const textNodes = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const current = textNodes.reverse().find((node) => (node.textContent || "").trim().length > 0);
    if (current) {
      current.textContent = label;
      return;
    }

    button.textContent = label;
  }

  function setPuzzleIcon(button) {
    const icon = createPuzzleIcon();
    const currentIcon = button.querySelector("svg");
    if (currentIcon) {
      for (const attribute of ["class", "style", "width", "height"]) {
        const value = currentIcon.getAttribute(attribute);
        if (value) icon.setAttribute(attribute, value);
      }
      currentIcon.replaceWith(icon);
      return;
    }

    button.prepend(icon);
  }

  function createPuzzleIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML =
      '<path d="M14 7V5a2 2 0 0 0-4 0v2H7a2 2 0 0 0-2 2v3h2a2 2 0 1 1 0 4H5v3a2 2 0 0 0 2 2h3v-2a2 2 0 1 1 4 0v2h3a2 2 0 0 0 2-2v-3h-2a2 2 0 1 1 0-4h2V9a2 2 0 0 0-2-2h-3Z" />';
    return svg;
  }

  function showLensPanel(sidebar, content, button) {
    const panel = ensureLensPanel(content);
    if (!panel) return;

    syncNativeSelection(sidebar, button);

    Array.from(content.children).forEach((child) => {
      if (child === panel) return;
      if (child.dataset.lensPreviousDisplay === undefined) {
        child.dataset.lensPreviousDisplay = child.style.display;
      }
      child.style.display = "none";
    });

    panel.hidden = false;
    button.setAttribute("aria-current", "page");
    button.setAttribute("aria-selected", "true");
    panel.focus({ preventScroll: true });
  }

  function ensureLensPanel(content) {
    let panel = content.querySelector('[data-lens-settings="panel"]');
    if (panel) return panel;

    panel = document.querySelector('[data-lens-settings="panel"]');
    if (panel) {
      content.appendChild(panel);
      return panel;
    }

    return createLensPanel(content);
  }

  function createLensPanel(content) {
    const section = document.createElement("section");
    section.dataset.lensSettings = "panel";
    section.hidden = true;
    section.tabIndex = -1;
    section.innerHTML = `
    <style>
      [data-lens-settings="category"] {
        margin-top: 0;
      }
      [data-lens-settings="category-label"] {
        pointer-events: none;
      }
      [data-lens-settings="nav"] {
        cursor: pointer;
      }
      [data-lens-settings="panel"] {
        display: grid;
        align-content: start;
        gap: 20px;
        box-sizing: border-box;
        min-height: 100%;
        padding: 16px 18px;
      }
      [data-lens-settings="panel"][hidden] {
        display: none !important;
      }
      [data-lens-settings="header"] {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      [data-lens-settings="title"] {
        margin: 0;
        font: 600 18px/1.2 system-ui, sans-serif;
      }
      [data-lens-settings="hint"] {
        display: none;
        margin: 0;
        color: color-mix(in srgb, currentColor 68%, transparent);
        font: 12px/1.4 system-ui, sans-serif;
      }
      [data-lens-settings="list"] {
        display: grid;
        gap: 0;
      }
      [data-lens-settings="plugin"] {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        padding: 18px 0;
      }
      [data-lens-settings="plugin-copy"] {
        display: grid;
        min-width: 0;
      }
      [data-lens-settings="plugin-name"] {
        color: color-mix(in srgb, currentColor 92%, transparent);
        font: 600 15px/1.35 system-ui, sans-serif;
      }
      [data-lens-settings="plugin-source"] {
        display: none;
        max-width: 42ch;
        overflow: hidden;
        color: color-mix(in srgb, currentColor 58%, transparent);
        font: 11px/1.3 ui-monospace, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-lens-settings="plugin-description"] {
        margin-top: 4px;
        color: color-mix(in srgb, currentColor 54%, transparent);
        font: 14px/1.45 system-ui, sans-serif;
      }
      [data-lens-settings="toggle"] {
        position: relative;
        display: inline-flex;
        min-width: 38px;
        min-height: 22px;
        flex: 0 0 auto;
        align-items: center;
        margin-top: 2px;
      }
      [data-lens-settings="toggle"] input {
        position: absolute;
        inset: 0;
        margin: 0;
        opacity: 0;
        cursor: pointer;
      }
      [data-lens-settings="toggle-track"] {
        width: 38px;
        height: 22px;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, canvas 82%, currentColor 8%);
        transition: background 120ms ease;
      }
      [data-lens-settings="toggle-track"]::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 16px;
        height: 16px;
        border-radius: 4px;
        background: color-mix(in srgb, currentColor 42%, transparent);
        box-shadow: none;
        transition: transform 120ms ease;
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"] {
        background: color-mix(in srgb, currentColor 14%, transparent);
      }
      [data-lens-settings="toggle"] input:checked + [data-lens-settings="toggle-track"]::after {
        transform: translateX(16px);
      }
      [data-lens-settings="reload"] {
        border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
        border-radius: 999px;
        padding: 6px 10px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: 12px/1 system-ui, sans-serif;
      }
    </style>
    <div data-lens-settings="header">
      <h2 data-lens-settings="title">Plugins</h2>
      <button type="button" data-lens-settings="reload">Reload UI</button>
    </div>
    <p data-lens-settings="hint">Enable or disable plugins, then reload OpenCode Web to apply the current set.</p>
    <div data-lens-settings="list">Loading plugins...</div>
  `;

    content.appendChild(section);
    section
      .querySelector('[data-lens-settings="reload"]')
      ?.addEventListener("click", () => location.reload());
    renderPluginList(section);
    return section;
  }

  function restoreSettingsPanel(content) {
    const panel = content.querySelector('[data-lens-settings="panel"]');
    if (panel) panel.hidden = true;

    Array.from(content.children).forEach((child) => {
      if (child === panel) return;
      if (child.dataset.lensPreviousDisplay !== undefined) {
        child.style.display = child.dataset.lensPreviousDisplay;
        delete child.dataset.lensPreviousDisplay;
      }
    });
  }

  function syncNativeSelection(sidebar, lensButton) {
    const active = Array.from(sidebar.querySelectorAll("button")).find(
      (button) => button !== lensButton && isSelectedButton(button),
    );
    const inactive = Array.from(sidebar.querySelectorAll("button")).find(
      (button) => button !== lensButton && !isSelectedButton(button),
    );

    if (active instanceof HTMLElement) {
      lensButton.className = active.className;
      lensButton.dataset.lensActiveClass = active.className;
    }

    if (inactive instanceof HTMLElement) {
      for (const button of sidebar.querySelectorAll("button")) {
        if (button !== lensButton && isSelectedButton(button)) {
          clearButtonSelection(button, inactive.className);
        }
      }
    }

    lensButton.setAttribute("aria-current", "page");
    lensButton.setAttribute("aria-selected", "true");
    lensButton.dataset.selected = "true";
    lensButton.dataset.active = "true";
  }

  function setLensSelected(sidebar, selected) {
    const button = sidebar.querySelector('[data-lens-settings="nav"]');
    if (!(button instanceof HTMLElement)) return;

    if (selected) {
      button.setAttribute("aria-current", "page");
      button.setAttribute("aria-selected", "true");
      return;
    }

    button.removeAttribute("aria-current");
    button.setAttribute("aria-selected", "false");
    delete button.dataset.selected;
    delete button.dataset.active;
    if (button.dataset.lensInactiveClass !== undefined) {
      button.className = button.dataset.lensInactiveClass;
    }
  }

  function clearButtonSelection(button, inactiveClass) {
    button.removeAttribute("aria-current");
    button.setAttribute("aria-selected", "false");
    delete button.dataset.selected;
    delete button.dataset.active;
    if (button instanceof HTMLElement) button.className = inactiveClass;
  }

  function isSelectedButton(button) {
    return (
      button.getAttribute("aria-current") === "page" ||
      button.getAttribute("aria-selected") === "true" ||
      button.matches('[data-selected="true"],[data-active="true"]') ||
      hasActiveVisual(button)
    );
  }

  function hasActiveVisual(button) {
    const background = getComputedStyle(button).backgroundColor;
    return Boolean(background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)");
  }

  function findButtonByText(root, text) {
    return Array.from(root.querySelectorAll("button")).find(
      (button) => (button.textContent || "").trim() === text,
    );
  }

  async function renderPluginList(section) {
    const list = section.querySelector('[data-lens-settings="list"]');
    if (!list) return;

    try {
      const response = await fetch("/__lens/plugins");
      const data = await response.json();
      list.textContent = "";

      if (!data.plugins?.length) {
        list.textContent = "No plugins are registered with Lens.";
        return;
      }

      for (const plugin of data.plugins) {
        const row = document.createElement("label");
        row.dataset.lensSettings = "plugin";
        row.innerHTML = `
        <span data-lens-settings="plugin-copy">
          <span data-lens-settings="plugin-name"></span>
          <span data-lens-settings="plugin-description"></span>
          <span data-lens-settings="plugin-source"></span>
        </span>
      `;
        row.querySelector('[data-lens-settings="plugin-name"]').textContent = plugin.name;
        row.querySelector('[data-lens-settings="plugin-description"]').textContent =
          plugin.description || "No description provided.";
        row.querySelector('[data-lens-settings="plugin-source"]').textContent =
          plugin.source || plugin.id;

        const checkbox = createPluginSwitch();
        row.appendChild(checkbox.label);
        checkbox.checked = plugin.enabled;
        checkbox.onChange = async () => {
          checkbox.disabled = true;
          await fetch("/__lens/plugins/" + encodeURIComponent(plugin.id), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: checkbox.checked }),
          });
          location.reload();
        };

        list.appendChild(row);
      }
    } catch (error) {
      list.textContent = "Lens settings failed to load.";
      console.error(error);
    }
  }

  function createPluginSwitch() {
    const nativeSwitch = cloneAutoAcceptSwitch();
    const label = document.createElement("span");
    label.dataset.lensSettings = "toggle";

    if (nativeSwitch) {
      label.appendChild(nativeSwitch);
      const control = nativeSwitch.matches('input,button,[role="switch"]')
        ? nativeSwitch
        : nativeSwitch.querySelector('input,button,[role="switch"]');

      const api = {
        label,
        get checked() {
          return getSwitchChecked(control);
        },
        set checked(value) {
          setSwitchChecked(control, value);
        },
        set disabled(value) {
          setSwitchDisabled(control, value);
        },
        onChange: undefined,
      };

      nativeSwitch.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        api.checked = !api.checked;
        api.onChange?.();
      });

      return api;
    }

    label.innerHTML = `
      <input type="checkbox" role="switch" />
      <span data-lens-settings="toggle-track"></span>
    `;

    const input = label.querySelector("input");
    const api = {
      label,
      get checked() {
        return input.checked;
      },
      set checked(value) {
        input.checked = value;
      },
      set disabled(value) {
        input.disabled = value;
      },
      onChange: undefined,
    };

    input.addEventListener("change", () => api.onChange?.());
    return api;
  }

  function cloneAutoAcceptSwitch() {
    const heading = Array.from(document.querySelectorAll("div,span,p,h2,h3,h4,label")).find(
      (candidate) => /Auto-accept permissions/i.test(candidate.textContent || ""),
    );
    let current = heading?.parentElement;

    while (current && current !== document.body) {
      const control = current.querySelector('input[type="checkbox"],button,[role="switch"]');
      if (control) return control.cloneNode(true);
      current = current.parentElement;
    }
  }

  function getSwitchChecked(control) {
    if (control instanceof HTMLInputElement) return control.checked;
    return control?.getAttribute("aria-checked") === "true" || control?.dataset.state === "checked";
  }

  function setSwitchChecked(control, checked) {
    if (!control) return;
    if (control instanceof HTMLInputElement) control.checked = checked;
    control.setAttribute("aria-checked", String(checked));
    control.dataset.state = checked ? "checked" : "unchecked";
    control.toggleAttribute("checked", checked);
  }

  function setSwitchDisabled(control, disabled) {
    if (!control) return;
    if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) {
      control.disabled = disabled;
    }
    control.setAttribute("aria-disabled", String(disabled));
  }
}.toString()})();`;
