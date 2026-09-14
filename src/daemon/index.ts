import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { Logger } from "./log.js";
import { OpencodeClient } from "./opencode/client.js";
import { Registry } from "./core/registry.js";
import { Orchestrator } from "./core/orchestrator.js";
import { Hub } from "./transport/hub.js";
import { TtsEngine } from "./engines/tts.js";
import { SttEngine } from "./engines/stt.js";

/**
 * Daemon entry point. `startDaemon` is also used by the integration tests, so
 * everything the process does is reachable without spawning it.
 */

export type Daemon = {
  cfg: Config;
  hub: Hub;
  orchestrator: Orchestrator;
  client: OpencodeClient;
  registry: Registry;
  logger: Logger;
  port: number;
  stop: () => Promise<void>;
};

export async function startDaemon(cfg: Config, opts: { fetch?: typeof fetch; logger?: Logger } = {}): Promise<Daemon> {
  const logger = opts.logger ?? new Logger({ level: cfg.logLevel });
  const log = logger.scope("daemon");
  const version = readVersion();
  const client = new OpencodeClient({
    baseUrl: cfg.opencode.url,
    username: cfg.opencode.username,
    password: cfg.opencode.password,
    fetch: opts.fetch,
    log: logger.scope("opencode"),
  });
  const registry = new Registry(cfg.dataDir);
  const tts = new TtsEngine(cfg.tts, logger.scope("tts"), opts.fetch);
  const stt = new SttEngine(cfg.stt, logger.scope("stt"), opts.fetch);
  const hub = new Hub({ cfg, logger, tts, stt, version });
  const orchestrator = new Orchestrator(cfg, client, registry, hub, logger);
  hub.attach(orchestrator);
  orchestrator.restoreBindings();

  const { port } = await hub.listen();
  log.info("listening", { host: cfg.host, port, opencode: cfg.opencode.url, version });

  const abort = new AbortController();
  const sse = client.subscribeGlobal((env) => orchestrator.handle(env), {
    signal: abort.signal,
    onOpen: () => {
      orchestrator.setConnected(true);
      log.info("opencode event stream connected", { url: cfg.opencode.url });
    },
    onClose: (err) => orchestrator.setConnected(false, err?.message),
  });
  void Promise.all([tts.check(true), stt.check(true)]).then(() => {
    log.info("engines", { tts: tts.describe(), stt: stt.describe() });
  });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    orchestrator.dispose();
    registry.saveNow();
    await hub.close();
    await sse.catch(() => undefined);
  };
  return { cfg, hub, orchestrator, client, registry, logger, port, stop };
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "..", "..", "package.json")]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // next
      }
    }
  } catch {
    // ignore
  }
  return "0.0.0";
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cfg = loadConfig();
  startDaemon(cfg)
    .then((daemon) => {
      const shutdown = (signal: string) => {
        daemon.logger.scope("daemon").info("shutting down", { signal });
        void daemon.stop().then(() => process.exit(0));
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((e) => {
      process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
      process.exit(1);
    });
}
