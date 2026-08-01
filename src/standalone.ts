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
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { loadConfig, saveConfig } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { createMessageRouter } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { DiscordProvider } from "./transports/discord.js";
import { TransportManager } from "./transports/manager.js";
import { MatrixProvider } from "./transports/matrix.js";
import { SlackProvider } from "./transports/slack.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";

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

function parseArgs(argv: string[]): { workdir?: string } {
  const result: { workdir?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--workdir":
        result.workdir = argv[++i];
        break;
      case "--setup":
      case "--configure":
        console.warn("⚠️  旧参数已废弃,请用 `pi-remote setup`");
        break;
      case "--pi-cli":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/msg-bridge.json 配置 cliPath,或设 PI_CLI_PATH");
        i++;
        break;
      case "--session-dir":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/msg-bridge.json 配置 sessionDir");
        i++;
        break;
      case "--debug":
        console.warn("⚠️  旧参数已废弃,请在 ~/.pi/msg-bridge.json 配置 debug: true");
        break;
      default:
        console.warn(`[bridge] ignoring unknown argument: ${arg}`);
    }
  }
  return result;
}

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // Single-instance guard (same lock file as the extension mode)
  if (!acquireLock()) {
    console.error("[bridge] another msg-bridge instance is already running — exiting");
    process.exit(1);
  }

  const config = loadConfig();
  const debug = config.debug === true;
  const workdir = args.workdir ?? config.workdir;
  const sessionDir = config.sessionDir;
  const cliPath = config.cliPath;

  const auth = new ChallengeAuth(
    (code, username) => log(`🔐 Challenge code for @${username}: ${code}`),
    (message, level) => log(`[auth:${level ?? "info"}] ${message}`),
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

  if (config.telegram?.token) {
    addTransport(new TelegramProvider(config.telegram.token, auth));
  }
  if (config.whatsapp) {
    const authPath = config.whatsapp.authPath || path.join(os.homedir(), ".pi", "msg-bridge-whatsapp-auth");
    if (fs.existsSync(path.join(authPath, "creds.json"))) {
      addTransport(new WhatsAppProvider({ ...config.whatsapp, debug }, auth));
    } else {
      delete config.whatsapp;
      saveConfig(config);
    }
  }
  if (config.slack?.botToken && config.slack?.appToken) {
    addTransport(new SlackProvider(config.slack, auth));
  }
  if (config.discord?.token) {
    addTransport(new DiscordProvider(config.discord, auth));
  }
  if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
    addTransport(new MatrixProvider(config.matrix, auth));
  }

  if (transportManager.getAllTransports().length === 0) {
    console.error(
      "[bridge] no transports configured. Configure ~/.pi/msg-bridge.json or set PI_* env vars (see README)."
    );
    releaseLock();
    process.exit(1);
  }

  // ---- pi RPC -------------------------------------------------------------
  const rpcArgs: string[] = [];
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
    } catch (err) {
      log(`⚠️ failed to send reply via ${transport}:`, (err as Error).message);
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
      log("❌ message handling error:", (err as Error).message);
    });
  });

  transportManager.onError((err, transport) => {
    log(`❌ ${transport} error:`, err.message);
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
    log("⚠️ some transports failed to connect:", (err as Error).message);
  }

  try {
    await rpc.start();
    const state = await rpc.getState();
    log(`✅ pi RPC connected (model: ${state.model?.id ?? "unknown"}, session: ${state.sessionId ?? "?"})`);
  } catch (err) {
    console.error("[bridge] failed to start pi RPC:", (err as Error).message);
    await transportManager.disconnectAll();
    releaseLock();
    process.exit(1);
  }

  // ---- shutdown ----------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`🛑 ${signal} received — shutting down`);
    await rpc.stop().catch(() => {});
    await transportManager.disconnectAll();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log("🚀 msg-bridge standalone ready. Waiting for messages...");
}

// Direct execution: `node dist/standalone.js [--workdir ...]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[bridge] fatal:", err);
    releaseLock();
    process.exit(1);
  });
}
