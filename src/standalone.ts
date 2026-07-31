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

function parseArgs(argv: string[]): {
  workdir?: string;
  cliPath?: string;
  sessionDir?: string;
  debug: boolean;
} {
  const out = { debug: false };
  const result = out as typeof out & { workdir?: string; cliPath?: string; sessionDir?: string };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case "--workdir":
        result.workdir = next();
        break;
      case "--pi-cli":
        result.cliPath = next();
        break;
      case "--session-dir":
        result.sessionDir = next();
        break;
      case "--debug":
        result.debug = true;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Single-instance guard (same lock file as the extension mode)
  if (!acquireLock()) {
    console.error("[bridge] another msg-bridge instance is already running — exiting");
    process.exit(1);
  }

  const config = loadConfig();
  const debug = args.debug || config.debug === true;

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
  if (args.sessionDir) {
    rpcArgs.push("--session-dir", args.sessionDir);
  }
  const rpc = new PiRpc({
    cliPath: args.cliPath,
    cwd: args.workdir,
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

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  releaseLock();
  process.exit(1);
});
