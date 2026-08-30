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

import { pathToFileURL } from "node:url";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { ConfigStore, loadConfig, saveConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel } from "./logger.js";
import { createMessageRouter } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { PmctlController } from "./rpc/pmctl-controller.js";
import { ProjectManager } from "./rpc/project-manager.js";
import type { RoomOps, Transport } from "./transports/interface.js";
import { MatrixProvider } from "./transports/matrix.js";
import { suppressKnownWarnings } from "./warnings.js";

suppressKnownWarnings();

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
        console.warn(`⚠️  忽略未知参数: ${arg}(旧参数已废弃,请用配置或子命令)`);
    }
  }
  return result;
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
  // One in-memory config for the whole process; everything below reads and
  // writes through it (no per-call disk access on the message hot path).
  const store = new ConfigStore(config);
  const workdir = await resolveWorkdir(args.workdir, config.workdir);
  const sessionDir = config.sessionDir;
  const cliPath = config.cliPath;

  // Log level: CLI --level > config.logLevel > default "info"
  const cliLevel = args.logLevel ? parseLogLevel(args.logLevel) : undefined;
  const configLevel = typeof config.logLevel === "string" ? parseLogLevel(config.logLevel) : undefined;
  setLogLevel(cliLevel ?? configLevel ?? "info");

  const auth = new ChallengeAuth(
    (code, username) => logger.info(`🔐 Challenge code for @${username}: ${code}`),
    (message, level) => logger.info(`[auth:${level ?? "info"}] ${message}`)
  );
  // Auth state persistence flows through command effects (admin-commands.ts)
  // applied by the router via the injected store — the engine never saves.
  if (config.auth) {
    auth.loadFromConfig(config.auth);
  }

  // ---- transports ------------------------------------------------------------
  // A plain registry (no manager class): each configured transport is wired
  // inline below. Matrix additionally carries the RoomOps capability, which
  // is handed to the router separately (only the /pmctl path consumes it).
  const transports: Transport[] = [];
  const getTransport = (type: string): Transport | undefined => transports.find((t) => t.type === type);
  let roomOps: RoomOps | undefined;

  if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
    const matrix = new MatrixProvider(config.matrix, (chatId) => auth.isChannelEnabled(chatId));
    transports.push(matrix);
    roomOps = matrix;
  }

  if (transports.length === 0) {
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
      const t = getTransport(transport);
      if (!t) throw new Error(`Transport ${transport} not found`);
      if (!t.isConnected) throw new Error(`Transport ${transport} not connected`);
      await t.sendMessage(chatId, text);
      const short = text.replace(/\s+/g, " ").trim();
      logger.debug(`📤 [${transport}] ${short.slice(0, 500)}${short.length > 500 ? "…" : ""}`);
    } catch (err) {
      logger.error(`发送失败 (${transport}): ${(err as Error).message}`);
    }
  };
  // Silent no-op when the transport is missing/disconnected (typing is best-effort).
  const sendTyping = async (chatId: string, transport: string): Promise<void> => {
    const t = getTransport(transport);
    if (t?.isConnected) await t.sendTyping(chatId);
  };
  const disconnectAll = (): Promise<unknown> => Promise.allSettled(transports.map((t) => t.disconnect()));

  // ---- multi-project routing -------------------------------------------------
  // Project rooms get their own pi process (isolated cwd/session); DM and
  // unmapped rooms use the shared default Rpc. Agent events from a project
  // process are routed back to the owning room.
  const projectManager = new ProjectManager({
    defaultRpc: rpc,
    baseOptions: { cliPath, args: ["--continue"] },
    onRoomEvent: (_roomId, event, rpc) => {
      router.handleEvent(event, rpc);
    },
    store,
    multiProject: store.get().multiProject === true,
  });

  const pmctl = new PmctlController({ projectManager, roomOps, store });

  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply,
    sendTyping,
    roomOps,
    store,
    pmctl,
  });

  for (const t of transports) {
    t.onMessage((msg) => {
      router.handleIncoming(msg).catch((err) => {
        logger.error("❌ message handling error:", (err as Error).message);
      });
    });
    t.onError((err) => {
      logger.error(`❌ ${t.type} error:`, (err as Error).message);
    });
  }

  // ---- agent events → replies ------------------------------------------------
  rpc.onEvent((event) => {
    router.handleEvent(event, rpc);
  });

  // ---- startup ----------------------------------------------------------------
  try {
    await Promise.all(
      transports.map((t) =>
        t.connect().catch((err) => {
          throw new Error(`${t.type} connection failed: ${(err as Error).message}`);
        })
      )
    );
    logger.info(
      `✅ transports connected: ${transports.map((t) => `${t.type}=${t.isConnected ? "up" : "down"}`).join(", ")}`
    );
  } catch (err) {
    logger.warn("⚠️ some transports failed to connect:", (err as Error).message);
    // Friendly diagnostics for the two common E2EE/device-state failures so
    // users get the fix instead of a raw stack trace.
    const msg = (err as Error).message ?? "";
    if (msg.includes("M_BAD_JSON") && msg.includes("device_id")) {
      logger.warn("   → 本地加密存储与 token 的设备身份不一致(换过 token / 重登过)。");
      logger.warn("     解法:删除加密存储后重启 — rm -rf ~/.pi/pi-courier-matrix-crypto && pi-courier restart");
    } else if (msg.includes("One time key") || msg.includes("already exists")) {
      logger.warn("   → 服务器端 device 的 one-time key 记账与本地不一致。");
      logger.warn("     解法:重跑 `pi-courier setup`,在\"保留现有 token?\"处输 n 换新 token(新设备=服务器干净)。");
    }
  }

  try {
    await rpc.start();
    const state = await rpc.getState();
    logger.info(`✅ pi RPC connected (model: ${state.model?.id ?? "unknown"}, session: ${state.sessionId ?? "?"})`);
  } catch (err) {
    logger.error("[bridge] failed to start pi RPC:", (err as Error).message);
    await disconnectAll();
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
    await disconnectAll();
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
