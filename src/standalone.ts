/**
 * Standalone entry — runs the bridge as its own process (systemd-friendly),
 * talking to pi over RPC mode instead of living inside pi as an extension.
 *
 * Usage:
 *   node dist/standalone.js [--workdir <dir>] [--pi-cli <path>] [--session-dir <dir>] [--debug]
 *
 * Architecture:
 *   Messenger (Matrix/Telegram/...) ──> bridge ──> pi --mode rpc (JSONL over stdio)
 *   Messenger <── replies <────────── bridge <── agent events (stdout JSONL)
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel } from "./logger.js";
import { createMessageRouter } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";

// Suppress the known `util._extend` deprecation warning emitted by some
// transport dependencies at load time — it pollutes interactive output.
{
  const orig = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    if (msg.includes("util._extend")) return;
    (orig as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

function parseArgs(argv: string[]): { workdir?: string; logLevel?: string } {
  const result: { workdir?: string; logLevel?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--workdir":
        result.workdir = argv[++i];
        break;
      case "--level":
        result.logLevel = argv[++i];
        break;
      case "--setup":
      case "--configure":
        console.warn("⚠️  旧参数已废弃,请用 `pi-courier setup`");
        break;
      case "--pi-cli":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 cliPath,或设 PI_CLI_PATH");
        i++;
        break;
      case "--session-dir":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 sessionDir");
        i++;
        break;
      case "--debug":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/pi-courier.json 配置 debug: true");
        break;
      default:
        console.warn(`[bridge] ignoring unknown argument: ${arg}`);
    }
  }
  return result;
}

function log(...args: unknown[]): void {
  logger.info(...args);
}

/**
 * Resolve the pi working directory.
 *
 * Priority: CLI --workdir > config.workdir > prompt/default. When neither the
 * CLI nor the config provides one (first run), ask on an interactive terminal
 * (default: ~/Projects); in non-interactive contexts (systemd service) use the
 * default silently. Either way the resolved value is persisted to the config,
 * so the config stays the single source of truth and later edits take effect
 * on restart (LLM-friendly).
 */
async function resolveWorkdir(cliWorkdir: string | undefined, configWorkdir: string | undefined): Promise<string> {
  if (cliWorkdir) return cliWorkdir;
  if (configWorkdir) return configWorkdir;

  const fallback = path.join(os.homedir(), "Projects");
  let workdir = fallback;

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`未配置工作目录。请输入 pi 工作目录 [默认 ${fallback}]: `, (a) => resolve(a.trim()));
    });
    rl.close();
    if (answer) workdir = answer;
  }

  const cfg = loadConfig();
  cfg.workdir = workdir;
  saveConfig(cfg);
  logger.info(`工作目录: ${workdir}(已保存到 ~/.pi/pi-courier.json,改配置后重启即生效)`);
  return workdir;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // Single-instance guard (same lock file as the extension mode)
  if (!acquireLock()) {
    console.error("[bridge] another pi-courier instance is already running — exiting");
    process.exit(1);
  }

  const config = loadConfig();
  const debug = config.debug === true;
  const workdir = await resolveWorkdir(args.workdir, config.workdir);
  const sessionDir = config.sessionDir;
  const cliPath = config.cliPath;

  // Log level: CLI --level > config.logLevel > default "info"
  const cliLevel = args.logLevel ? parseLogLevel(args.logLevel) : undefined;
  const configLevel = typeof config.logLevel === "string" ? parseLogLevel(config.logLevel) : undefined;
  setLogLevel(cliLevel ?? configLevel ?? "info");

  const auth = new ChallengeAuth(
    (code, username) => logger.info(`🔐 Challenge code for @${username}: ${code}`),
    (message, level) => logger.info(`[auth:${level ?? "info"}] ${message}`),
    async (_chatId, _message) => {
      // Challenge prompts are sent via the transport's sendMessage
    },
    () => {
      const cfg = loadConfig();
      cfg.auth = auth.exportConfig();
      saveConfig(cfg);
    }
  );
  if (config.auth) {
    auth.loadFromConfig(config.auth);
  }

  const transportManager = new TransportManager();

  const addTransport = (transport: import("./transports/interface.js").ITransportProvider): void => {
    transportManager.addTransport(transport);
  };

  if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
    addTransport(new MatrixProvider(config.matrix, auth));
  }

  if (transportManager.getAllTransports().length === 0) {
    // No Matrix config yet — do NOT exit. Under systemd/docker restart
    // policies an exit(1) here crash-loops the service and makes
    // `pi-courier setup` unreachable (exec fails while restarting).
    // Stay up and wait for configuration instead.
    logger.warn("⚠️ 未配置 Matrix 连接(缺少 homeserver 或 access token)。");
    logger.warn("   请运行 `pi-courier setup` 完成配置,然后重启服务。");
    logger.warn("   等待配置中… (Ctrl+C / SIGTERM 退出)");
    await new Promise<never>(() => {
      // Keep the event loop alive — a bare promise has no handles, so the
      // process would exit immediately instead of waiting for configuration.
      setInterval(() => {}, 60_000);
    });
  }

  // ---- pi RPC -------------------------------------------------------------
  // --continue: resume the most recent session on restart (same as `pi -c`),
  // so bridge/service restarts and /reload keep the conversation context.
  const rpcArgs: string[] = ["--continue"];
  if (sessionDir) {
    rpcArgs.push("--session-dir", sessionDir);
  }
  const rpc = new PiRpc({
    cliPath,
    cwd: workdir,
    args: rpcArgs,
  });

  // ---- message routing ------------------------------------------------------
  const sendReply = async (chatId: string, transport: string, text: string): Promise<void> => {
    try {
      await transportManager.sendMessage(chatId, transport, text);
      const short = text.replace(/\s+/g, " ").trim();
      logger.debug(`📤 [${transport}] ${short.slice(0, 500)}${short.length > 500 ? "…" : ""}`);
    } catch (err) {
      logger.error(`发送失败 (${transport}): ${(err as Error).message}`);
    }
  };

  const router = createMessageRouter({
    rpc,
    auth,
    transportManager,
    sendReply,
    log,
    debug,
  });

  transportManager.onMessage((msg) => {
    router.handleIncoming(msg).catch((err) => {
      logger.error("❌ message handling error:", (err as Error).message);
    });
  });

  transportManager.onError((err, transport) => {
    logger.error(`❌ ${transport} error:`, (err as Error).message);
  });

  // ---- agent events → replies ------------------------------------------------
  rpc.onEvent((event) => {
    router.handleEvent(event);
  });

  // ---- startup ----------------------------------------------------------------
  try {
    await transportManager.connectAll();
    log(
      `✅ transports connected: ${transportManager
        .getStatus()
        .map((s) => `${s.type}=${s.connected ? "up" : "down"}`)
        .join(", ")}`
    );
  } catch (err) {
    logger.warn("⚠️ some transports failed to connect:", (err as Error).message);
  }

  try {
    await rpc.start();
    const state = await rpc.getState();
    logger.info(`✅ pi RPC connected (model: ${state.model?.id ?? "unknown"}, session: ${state.sessionId ?? "?"})`);
  } catch (err) {
    logger.error("[bridge] failed to start pi RPC:", (err as Error).message);
    await transportManager.disconnectAll();
    releaseLock();
    process.exit(1);
  }

  // ---- shutdown ----------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`🛑 ${signal} received — shutting down`);
    await rpc.stop().catch(() => {});
    await transportManager.disconnectAll();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info("🚀 pi-courier ready. Waiting for messages...");
}

// Direct execution: `node dist/standalone.js [--workdir ...]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[bridge] fatal:", err);
    releaseLock();
    process.exit(1);
  });
}
