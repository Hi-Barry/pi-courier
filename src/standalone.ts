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

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AUDIT_EVENTS, AuditLog } from "./audit/audit-log.js";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import {
  attachmentsDirectory,
  attachmentsMaxBytes,
  CONFIG_DIR,
  ConfigStore,
  inboxMode,
  managementRoomId,
  presetProblems,
  resolveLanguage,
  THINKING_LEVELS,
} from "./config.js";
import { errorMessage } from "./errors.js";
import { truncateLine } from "./formatting.js";
import { setLocale, t } from "./i18n/index.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel } from "./logger.js";
import { ReminderClock } from "./reminders/reminder-clock.js";
import type { ReminderEntry } from "./reminders/reminder-store.js";
import { ReminderStore } from "./reminders/reminder-store.js";
import { createMessageRouter, type PersistedAttachmentEntry } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { PmctlController } from "./rpc/pmctl-controller.js";
import { ProjectManager } from "./rpc/project-manager.js";
import { consumeQueueSnapshots, type QueueSnapshotEntry, QueueSnapshotStore } from "./rpc/queue-snapshots.js";
import { ensureSpaceAndManagementRoom } from "./space-topology.js";
import { createStartupState, runStartupHeals } from "./startup-state.js";
import { JsonStateFile } from "./state/json-file.js";
import { AttachmentStore } from "./transports/attachments.js";
import { FileEventLedger } from "./transports/event-ledger.js";
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
        console.warn(t("cli.arg.deprecatedSetup"));
        break;
      case "--pi-cli":
        console.warn(t("cli.arg.deprecatedCliPath"));
        i++;
        break;
      case "--session-dir":
        console.warn(t("cli.arg.deprecatedSessionDir"));
        i++;
        break;
      case "--debug":
        console.warn(t("cli.arg.deprecatedDebug"));
        break;
      default:
        console.warn(t("cli.arg.unknown", { arg }));
    }
  }
  return result;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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

  // 语言解析(issue #83)必须在 parseArgs 之前:废弃参数警告跟随语言。
  const language = resolveLanguage(store.get());
  setLocale(language.locale);
  if (language.source === "system" || language.source === "default") {
    logger.info(
      t(
        language.source === "system" ? "startup.language.system" : "startup.language.default",
        { locale: language.locale }
      )
    );
  }

  const args = parseArgs(argv);
  // 项目预设与降级链的启动校验(issue #119/#121):只提示不拦截 —— 坏条目
  // 在应用/切换时被跳过,绝不让一条手编错误挡住进程启动。
  for (const problem of presetProblems(store.get())) {
    if (problem.code === "modelRef") {
      logger.warn(t("startup.preset.badModelRef", { path: problem.path, value: problem.value ?? "" }));
    } else if (problem.code === "thinkingLevel") {
      logger.warn(
        t("startup.preset.badThinkingLevel", {
          path: problem.path,
          value: problem.value ?? "",
          allowed: THINKING_LEVELS.join(", "),
        })
      );
    } else {
      logger.warn(t("startup.preset.badFallbacksList", { path: problem.path }));
    }
  }
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

  // ---- startup state (spec #99 票7 / #106) ----------------------------------
  // 组合根的三块启动期状态(配对码去向、收养许可、自愈编排)收进可注入
  // 模块,先于一切使用它的接线构造:ChallengeAuth 的回调从第一天就指向
  // 已构造的槽 —— 不再有「先声明、约 200 行后才赋值 + 注释保平安」的
  // 晚绑定;槽未接线时配对码进缓冲,接线后补发。
  const startup = createStartupState({ store });
  const auth = new ChallengeAuth(
    (code, username) => {
      logger.info(`🔐 Challenge code for @${username}: ${code}`);
      void startup.sendPairingNotice(
        t("startup.pairingNotice", { username, code })
      );
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
    // 项目预设回执(issue #119):应用/失败各一行,发进项目房。sendReply
    // 声明在下方 —— 与 onRoomEvent → router 同款闭包次序,调用只发生在
    // 进程启动之后,构造期从不触及。
    notifyRoom: (roomId, text) => {
      void sendReply(roomId, "matrix", text);
    },
  });

  // ---- message routing ------------------------------------------------------
  const sendReply = async (chatId: string, transport: string, text: string): Promise<void> => {
    try {
      // transport 参数仅诊断显示(下方日志与错误文案拼贴),不参与 adapter
      // 查找 —— C8 退役注册表后,全文已无按 transport 名寻址的消费方
      // (grep 证实:仅剩字符串插值);签名保留以维持日志口径不变。
      // ExternalMessage.transport 字段本身是路由元数据,照旧携带。
      const provider = matrix;
      if (!provider) throw new Error(`Transport ${transport} not found`);
      if (!provider.isConnected) throw new Error(`Transport ${transport} not connected`);
      await provider.sendMessage(chatId, text);
      logger
        .withLabel(projectManager.labelForRoom(chatId))
        .debug(`📤 [${transport}] ${truncateLine(text, 500)}`);
    } catch (err) {
      logger.error(`发送失败 (${transport}): ${errorMessage(err)}`);
    }
  };
  // Silent no-op when the transport is missing/disconnected (typing is best-effort).
  const sendTyping = async (chatId: string, _transport: string): Promise<void> => {
    if (matrix?.isConnected) await matrix.sendTyping(chatId);
  };
  const disconnectAll = (): Promise<unknown> => (matrix ? matrix.disconnect() : Promise.resolve());

  // 配对码去向接线(票7,spec #99 #106):落地目标此刻才存在 —— 交给启动
  // 状态模块持槽;此前到达的配对码已被缓冲,接线即按序补发。不等待:补发
  // 永不阻塞启动(常规路径缓冲为空,这就是一次纯赋值)。
  void startup.wirePairingSink(sendReply);

  // ---- space (organizational) mode -----------------------------------------
  // With the space enabled (multi-project only), the management room is
  // bot-created inside the space at startup; adopting the first DM is
  // reserved for the degraded path (space ensure failed this run). Note:
  // a DM arriving while the ensure is still in flight is served normally
  // but not adopted — same accepted startup-window class as the lazy
  // project-process early events.
  // 收养许可的两态(初值 !isSpaceMode,降级唯一翻转口 allowAdoption)归
  // 启动状态模块持有;router 只拿到只读查询。
  const pmctl = new PmctlController({ projectManager, roomOps, store });

  // ---- durable state (issue #114) --------------------------------------------
  // ~/.pi/pi-courier-state/(0700)收桥的派生状态文件:磁盘是备份,内存是热路径。
  // 配置(pi-courier.json)、Matrix SDK 存储、PID 锁各归 ~/.pi 原位,不迁。
  const stateDir = path.join(CONFIG_DIR, "pi-courier-state");
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn(`state dir unavailable (state files degrade to in-memory): ${errorMessage(err)}`);
  }
  const attachmentsLedger = new JsonStateFile<PersistedAttachmentEntry[]>(
    path.join(stateDir, "pending-attachments.json"),
    []
  );

  // ---- offline inbox (issue #113):已处理事件台账 -----------------------------
  // JSONL 追加 + 启动压实(7 天窗);首运会话(freshStart)里 stale 维持全丢,
  // 自第二个会话起「stale 且台账没见过」= 离线积压。模式来自 config 派生,
  // off = 与旧版逐字节一致。transport 在装配后回填(与附件仓库同一接缝)。
  const eventLedger = new FileEventLedger(path.join(stateDir, "event-ledger.jsonl"));
  matrix?.setEventLedger(eventLedger, inboxMode(config));

  // ---- queue snapshots (issue #115 阶段2):队列镜像的磁盘半边 ------------------
  // 镜像每次变化(经 router 注入的落盘缝)进/出 queue-snapshots.json;服务级
  // 重启后由下方启动消费补发「未执行」回执。只覆盖多工程项目房 —— 项目房↔
  // 进程映射在 config 里跨重启稳定;单工程默认进程绑运行时 DM,还原会误发
  // 旧房间,按票面保守路线整段不做。
  const queueSnapshots = new QueueSnapshotStore(
    new JsonStateFile<QueueSnapshotEntry[]>(path.join(stateDir, "queue-snapshots.json"), [])
  );

  // ---- audit log (issue #124):敏感动作的追加式证据 ----------------------------
  // audit.jsonl 只追加不改写(排查即证据),10MB 轮转留 2 份;写失败计数到
  // 阈值向管理房告警一次(审计故障不放大成可用性故障,但一定可见)。启动
  // 即写一行 bridge.start —— 顺带当可写性探针,写不进去启动横幅就报警。
  const auditLog = new AuditLog(path.join(stateDir, "audit.jsonl"), {
    onDegraded: (message) => {
      const managementRoom = managementRoomId(store.get());
      if (managementRoom) {
        void sendReply(managementRoom, "matrix", t("audit.degraded", { message }));
      }
    },
  });
  auditLog.append(AUDIT_EVENTS.bridgeStart, "system", "", `pi-courier started (pid ${process.pid})`);

  // ---- reminders (issue #117):先落盘再跑,重启不丢 ---------------------------
  // 时钟句柄不跨进程:reminders.json 才是真相,start() 在 transports 连接后
  // 重装载并补起全部定时器,离线窗口过期的提醒立即补投(注明迟到)。
  const reminderStore = new ReminderStore(
    new JsonStateFile<ReminderEntry[]>(path.join(stateDir, "reminders.json"), [])
  );
  const reminderClock = new ReminderClock(reminderStore, (delivery) =>
    sendReply(delivery.chatId, delivery.transport, delivery.text)
  );

  // 离线积压结算冻结信号(#136 修法B):onMessage 在 connect() resolve 前
  // 就接好,初始同步的 replayed 积压先于「transports connected」进缓冲,旧
  // 5s 定时器会在未连接里开火、征询发不出去按忽略丢积压。信号在连接阶段
  // 结束后统一放行(成功或已处理的失败分支都放 = 降级态回旧语义)。
  let releaseBacklogSettle!: () => void;
  const backlogTransportsReady = new Promise<void>((resolve) => {
    releaseBacklogSettle = resolve;
  });

  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply,
    sendTyping,
    roomOps,
    store,
    pmctl,
    managementRoomAdoptionAllowed: () => startup.managementRoomAdoptionAllowed(),
    attachmentsLedger,
    reminders: reminderClock,
    queueSnapshots,
    audit: auditLog,
    backlogTransportsReady,
  });

  // 房间消亡销账(issue #114/#117 后续):/pmctl rm 确认后清掉该房间的附件
  // 清单与提醒 —— 意图已无人能兑现,不等 TTL。此时 router/时钟才存在,故在
  // 装配后回填;失败在 pmctl 侧已兜(仅 warn),这里不加层。
  pmctl.onRoomRemoved = (roomId) => {
    const attachments = router.purgeRoomAttachments(roomId);
    const reminders = reminderClock.purgeRoom(roomId);
    // 队列快照同批销账(issue #115 阶段2):项目没了,「未执行」报告无人可投。
    queueSnapshots.remove(roomId);
    if (attachments + reminders > 0) {
      logger.info(`purged room state after project removal: ${attachments} attachment(s), ${reminders} reminder(s)`);
    }
  };

  matrix?.onMessage((msg) => {
    router.handleIncoming(msg).catch((err) => {
      logger.error("❌ message handling error:", errorMessage(err));
    });
  });
  matrix?.onError((err) => {
    logger.error(`❌ ${matrix.type} error:`, errorMessage(err));
  });

  // ---- agent events → replies ------------------------------------------------
  rpc.onEvent((event) => {
    router.handleEvent(event, rpc);
  });

  // ---- startup ----------------------------------------------------------------
  try {
    await matrix?.connect().catch((err: unknown) => {
      throw new Error(`matrix connection failed: ${errorMessage(err)}`);
    });
    logger.info(`✅ transports connected: matrix=${matrix?.isConnected ? "up" : "down"}`);
  } catch (err) {
    logger.warn("⚠️ some transports failed to connect:", errorMessage(err));
    // Friendly diagnostics for the two common E2EE/device-state failures so
    // users get the fix instead of a raw stack trace.
    const msg = errorMessage(err);
    if (msg.includes("M_BAD_JSON") && msg.includes("device_id")) {
      logger.warn("   → 本地加密存储与 token 的设备身份不一致(换过 token / 重登过)。");
      logger.warn("     解法:删除加密存储后重启 — rm -rf ~/.pi/pi-courier-matrix-crypto && pi-courier restart");
    } else if (msg.includes("One time key") || msg.includes("already exists")) {
      logger.warn("   → 服务器端 device 的 one-time key 记账与本地不一致。");
      logger.warn("     解法:重跑 `pi-courier setup`,在\"保留现有 token?\"处输 n 换新 token(新设备=服务器干净)。");
    }
  }
  // 连接阶段结束(成功或已处理的失败),放行离线积压结算(#136)。
  releaseBacklogSettle();

  // ---- queue snapshot consumption (issue #115 阶段2) --------------------------
  // 服务级重启后的「未执行」回执此刻补发:上个进程欠的排队清单,逐项目房
  // 一条,发完即清(consume-once)。矩阵没连上就整段跳过 —— 条目留给下次
  // 成功启动,连接级故障不许销毁报告;send 直连 transport(失败抛错可见),
  // 单房失败仅 warn 且条目照清:快照是死亡进程的报告,不是投递承诺。
  if (matrix?.isConnected) {
    await consumeQueueSnapshots(queueSnapshots, {
      isProjectRoom: (roomId) => projectManager.isProjectRoom(roomId),
      send: (roomId, text) => matrix.sendMessage(roomId, text),
    }).catch((err: unknown) => {
      logger.warn(`queue snapshot consumption failed: ${errorMessage(err)}`);
    });
  }

  // ---- space ensure -----------------------------------------------------------
  // Lazy + idempotent (config.space.roomId / managementRooms[0]); any failure
  // degrades to the unspace'd behaviour and re-opens DM adoption. Runs before
  // rpc.start so the room wiring is complete before the first prompt lands.
  // 提醒时钟也在此刻启动(issue #117):迟到补投要走 sendReply,必须等
  // transport 连接落定 —— 早发必被"未连接"吞掉,提醒就真丢了。
  await reminderClock.start().catch((err: unknown) => {
    logger.warn(`reminder clock failed to start: ${errorMessage(err)}`);
  });
  if (roomOps) {
    const spaceResult = await ensureSpaceAndManagementRoom({ roomOps, store, sendReply });
    if (spaceResult === "degraded") startup.allowAdoption();

    // #42 票1: trusted users are admins in every managed room. Runs
    // unconditionally — space or degraded mode alike (the adopted-DM
    // management room and project rooms need it as much as a bot-created
    // one); per-room failures warn inside and never touch the startup
    // tri-state above.
    // The whole heal sequence (power sweep → room identity → bot avatar)
    // lives in runStartupHeals — 编排自 space.ts 迁入启动状态模块
    // (spec #99 #105 建立,#106 票7 搬家)。Identity reads on fresh
    // rooms hit expected M_NOT_FOUNDs — silenced per call inside the
    // RoomOps adapter itself (matrix-rooms.ts), so no suppression window
    // is opened here anymore and new query-shaped heals stay quiet for
    // free.
    await runStartupHeals(roomOps, store);
  }

  try {
    await rpc.start();
    const state = await rpc.requireClient().getState();
    logger.info(`✅ pi RPC connected (model: ${state.model?.id ?? "unknown"}, session: ${state.sessionId ?? "?"})`);
  } catch (err) {
    logger.error("[bridge] failed to start pi RPC:", errorMessage(err));
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
