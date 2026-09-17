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

import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { attachmentsDirectory, attachmentsMaxBytes, ConfigStore, isSpaceMode } from "./config.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel , suppressLogLines } from "./logger.js";
import { createMessageRouter } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { PmctlController } from "./rpc/pmctl-controller.js";
import { ProjectManager } from "./rpc/project-manager.js";
import { ensureSpaceAndManagementRoom, healBotAvatar, healRoomIdentities, healTrustedPowerLevels } from "./space.js";
import { AttachmentStore } from "./transports/attachments.js";
import type { RoomOps } from "./transports/interface.js";
import { MatrixProvider } from "./transports/matrix.js";
import { suppressKnownWarnings } from "./warnings.js";
import { resolveWorkdir } from "./workdir.js";

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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // Single-instance guard (same lock file as the extension mode)
  if (!acquireLock()) {
    console.error("[bridge] another pi-courier instance is already running — exiting");
    process.exit(1);
  }

  // One load, one in-memory copy for the whole process; everything below —
  // including first-run workdir resolution — reads and writes through it.
  // There is no direct loadConfig/saveConfig use left in this file.
  // NOTE: resolve `config` only AFTER store.update calls are done — update()
  // replaces the in-memory object, so an earlier alias would go stale.
  const store = new ConfigStore();
  const workdir = await resolveWorkdir(args.workdir, store, undefined, (wd) =>
    logger.info(`工作目录: ${wd}(已保存到 ~/.pi/pi-courier.json,改配置后重启即生效)`)
  );
  const config = store.get();
  const sessionDir = config.sessionDir;
  const cliPath = config.cliPath;

  // Log level: CLI --level > config.logLevel > default "info"
  const cliLevel = args.logLevel ? parseLogLevel(args.logLevel) : undefined;
  const configLevel = typeof config.logLevel === "string" ? parseLogLevel(config.logLevel) : undefined;
  setLogLevel(cliLevel ?? configLevel ?? "info");

  // Pairing-code sink (spec #93 ticket 3): the code is only useful to the
  // ADMIN, who usually is not tailing the server log — mirror it into the
  // management room when one exists (degrades to log-only before adoption).
  // sendReply is declared further down; the callback cannot fire before the
  // startup wiring completes, so the late read is safe here.
  let sendPairingNotice: ((text: string) => Promise<void>) | undefined;
  const auth = new ChallengeAuth(
    (code, username) => {
      logger.info(`🔐 Challenge code for @${username}: ${code}`);
      void sendPairingNotice?.(`🔐 配对码 @${username}: ${code}(2 分钟内有效,发给该用户用于配对)`);
    },
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
  // 单 adapter 直连(spec #72 票8/C8):Transport 字符串注册表是只有一个
  // 实现的假想 seam —— 按同文件 RoomOps 注释的自我标准降级为组合根内部
  // 细节。第二个消息 transport 真正出现时,在这里重新立 seam。
  let matrix: MatrixProvider | undefined;
  let roomOps: RoomOps | undefined;

  if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
    // 赋值给外层变量(内层 const 会遮蔽,导致 !matrix 恒真——真机冒烟抓到)
    matrix = new MatrixProvider(config.matrix, (chatId) => auth.isChannelEnabled(chatId));
    // Attachment intake (issue #66): the store needs the Matrix client for
    // downloads, so it is created here and handed to the provider. Both read
    // config at construction time — changes take effect on restart like every
    // other config field.
    const attachments = new AttachmentStore(
      {
        rootDir: attachmentsDirectory(config),
        maxBytes: attachmentsMaxBytes(config),
      },
      matrix.mediaSource
    );
    matrix.setAttachmentStore(attachments);
    roomOps = matrix.roomOps;
  }

  if (!matrix) {
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

  // ---- multi-project routing -------------------------------------------------
  // Project rooms get their own pi process (isolated cwd/session); DM and
  // unmapped rooms use the shared default Rpc. Agent events from a project
  // process are routed back to the owning room.
  // Declared before sendReply below: outbound 📤 lines resolve their label
  // through labelForRoom (spec #34) — ordering kept explicit so the closure
  // does not rely on hoisting.
  const projectManager = new ProjectManager({
    defaultRpc: rpc,
    baseOptions: { cliPath, args: ["--continue"] },
    onRoomEvent: (_roomId, event, rpc) => {
      router.handleEvent(event, rpc);
    },
    store,
    multiProject: store.get().multiProject === true,
  });

  // ---- message routing ------------------------------------------------------
  const sendReply = async (chatId: string, transport: string, text: string): Promise<void> => {
    try {
      // transport 参数保留:ExternalMessage/ReplyTarget 的路由元数据与日志
      // 仍携带它;但查找 adapter 的注册表间接层已退役(C8)。
      const t = matrix;
      if (!t) throw new Error(`Transport ${transport} not found`);
      if (!t.isConnected) throw new Error(`Transport ${transport} not connected`);
      await t.sendMessage(chatId, text);
      const short = text.replace(/\s+/g, " ").trim();
      logger.withLabel(projectManager.labelForRoom(chatId)).debug(`📤 [${transport}] ${short.slice(0, 500)}${short.length > 500 ? "…" : ""}`);
    } catch (err) {
      logger.error(`发送失败 (${transport}): ${(err as Error).message}`);
    }
  };
  // Silent no-op when the transport is missing/disconnected (typing is best-effort).
  const sendTyping = async (chatId: string, transport: string): Promise<void> => {
    if (matrix?.isConnected) await matrix.sendTyping(chatId);
  };
  const disconnectAll = (): Promise<unknown> => (matrix ? matrix.disconnect() : Promise.resolve());

  // Late-bound pairing sink (see the ChallengeAuth callback above): forward
  // the pairing code into the management room when one is known.
  sendPairingNotice = (text: string): Promise<void> => {
    const mgmtRoom = store.get().managementRooms?.[0];
    return mgmtRoom ? sendReply(mgmtRoom, "matrix", text) : Promise.resolve();
  };

  // ---- space (organizational) mode -----------------------------------------
  // With the space enabled (multi-project only), the management room is
  // bot-created inside the space at startup; adopting the first DM is
  // reserved for the degraded path (space ensure failed this run). Note:
  // a DM arriving while the ensure is still in flight is served normally
  // but not adopted — same accepted startup-window class as the lazy
  // project-process early events.
  const spaceEnabled = isSpaceMode(store.get());
  let managementRoomAdoptionAllowed = !spaceEnabled;

  const pmctl = new PmctlController({ projectManager, roomOps, store });

  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply,
    sendTyping,
    roomOps,
    store,
    pmctl,
    managementRoomAdoptionAllowed: () => managementRoomAdoptionAllowed,
  });

  matrix?.onMessage((msg) => {
    router.handleIncoming(msg).catch((err) => {
      logger.error("❌ message handling error:", (err as Error).message);
    });
  });
  matrix?.onError((err) => {
    logger.error(`❌ ${matrix.type} error:`, (err as Error).message);
  });

  // ---- agent events → replies ------------------------------------------------
  rpc.onEvent((event) => {
    router.handleEvent(event, rpc);
  });

  // ---- startup ----------------------------------------------------------------
  try {
    await matrix?.connect().catch((err: unknown) => {
      throw new Error(`matrix connection failed: ${(err as Error).message}`);
    });
    logger.info(`✅ transports connected: matrix=${matrix?.isConnected ? "up" : "down"}`);
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

  // ---- space ensure -----------------------------------------------------------
  // Lazy + idempotent (config.space.roomId / managementRooms[0]); any failure
  // degrades to the unspace'd behaviour and re-opens DM adoption. Runs before
  // rpc.start so the room wiring is complete before the first prompt lands.
  if (roomOps) {
    const spaceResult = await ensureSpaceAndManagementRoom({ roomOps, store, sendReply });
    if (spaceResult === "degraded") managementRoomAdoptionAllowed = true;

    // #42 票1: trusted users are admins in every managed room. Runs
    // unconditionally — space or degraded mode alike (the adopted-DM
    // management room and project rooms need it as much as a bot-created
    // one); per-room failures warn inside and never touch the startup
    // tri-state above.
    // Startup-heal window (spec #93 票2): identity reads on fresh rooms hit
    // expected M_NOT_FOUNDs (no avatar/name state yet — the RoomOps members
    // turn them into null). The SDK still logs them as ERROR, drowning real
    // startup errors, so the pattern is silenced for the heal window only.
    const closeStartup404Window = suppressLogLines("M_NOT_FOUND");
    try {
      await healTrustedPowerLevels(roomOps, store);

      // Room identity (short space name + bundled avatars): space mode only,
      // best-effort per room — never blocks or fails the startup.
      await healRoomIdentities(roomOps, store);

      // Bot profile avatar (the agent's face, spec #84 ticket 2): every mode,
      // best-effort — 只补缺, agent-set migration window rebrands once.
      await healBotAvatar(roomOps, store);
    } finally {
      closeStartup404Window();
    }
  }

  try {
    await rpc.start();
    const state = await rpc.requireClient().getState();
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
