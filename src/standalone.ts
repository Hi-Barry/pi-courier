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
  bashTimeoutMinutes,
  CONFIG_DIR,
  ConfigStore,
  diskHardMb,
  diskSoftMb,
  heapAlertPercent,
  heartbeatIntervalSeconds,
  inboxMode,
  managementRoomId,
  presetProblems,
  resolveLanguage,
  rpcRespawnLimit,
  THINKING_LEVELS,
} from "./config.js";
import { errorMessage } from "./errors.js";
import { truncateLine } from "./formatting.js";
import { setLocale, t } from "./i18n/index.js";
import { acquireLock, releaseLock } from "./lock.js";
import { logger, parseLogLevel, setLogLevel } from "./logger.js";
import { applyProxySettings } from "./proxy.js";
import { ReminderClock } from "./reminders/reminder-clock.js";
import type { ReminderEntry } from "./reminders/reminder-store.js";
import { ReminderStore } from "./reminders/reminder-store.js";
import { CRASH_EXIT_CODE, createCrashGuard } from "./resilience/crash-guard.js";
import { diskFreeBytes } from "./resilience/disk-free.js";
import { Heartbeat } from "./resilience/heartbeat.js";
import { ResourceGuard } from "./resilience/resource-guard.js";
import { WriteFailureRecorder } from "./resilience/write-failure.js";
import type { PersistedAttachmentEntry } from "./rpc/attachment-ledger.js";
import { createMessageRouter } from "./rpc/message-router.js";
import { PiRpc } from "./rpc/pi-rpc.js";
import { PmctlController } from "./rpc/pmctl-controller.js";
import { ProjectManager } from "./rpc/project-manager.js";
import { consumeQueueSnapshots, type QueueSnapshotEntry, QueueSnapshotStore } from "./rpc/queue-snapshots.js";
import { createShutdownChain } from "./shutdown-chain.js";
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

  // ---- resource guard: startup disk hard threshold (spec #247 票04) -----------
  // 资源守卫先于一切网络接线构造并做启动期硬阈值检查(proxy/Matrix 连接/pi
  // 拉起都在其后):低于硬阈值只写死因日志即退、不发管理房留言 —— 「满盘 →
  // systemd 拉起 → 启动检查又硬退」的循环每轮不重连网络、不刷管理房,循环
  // 代价收敛为本地日志一行 + systemd StartLimitBurst 熔断(README 见)。
  const resourceGuard = new ResourceGuard({
    readDiskFreeBytes: () => diskFreeBytes(workdir),
    notify: (message) => {
      const mgmtRoom = managementRoomId(store.get());
      if (!mgmtRoom || !matrix?.isConnected) return;
      // 必须接 catch:sendReplyStrict 在未连接/发送失败时 reject,而
      // process 上的 unhandledRejection 崩溃守卫会把一条软告警发送失败
      // 升级成非零退出(可能形成崩溃循环)。同文件其他同类调用一律静默。
      void sendReplyStrict(mgmtRoom, message).catch(() => {});
    },
    onHardExit: (message) => {
      const mgmtRoom = managementRoomId(store.get());
      if (mgmtRoom && matrix?.isConnected) void sendReplyStrict(mgmtRoom, message).catch(() => {});
      void shutdownChain.shutdown("disk hard threshold", CRASH_EXIT_CODE).finally(() => process.exit(CRASH_EXIT_CODE));
    },
    log: (message) => logger.error(message),
    softBytes: diskSoftMb(config) * 1024 * 1024,
    hardBytes: diskHardMb(config) * 1024 * 1024,
    heapAlertPercent: heapAlertPercent(config),
  });
  if (resourceGuard.startHardThresholdBreached()) {
    releaseLock();
    process.exit(CRASH_EXIT_CODE);
  }

  // ---- outbound proxy (spec #201 票 #203) ------------------------------------
  // 出网代理接线必须先于任何出网:Matrix 客户端创建(底层 request 启动即读
  // 环境变量)、pi 拉起、向导进入都在其后。顺序:解析 → 校验 → 覆写进程
  // 环境(大小写两套)→ 装配 undici 代理调度器(桥自己的 fetch 腿)。无代
  // 理时 applyProxySettings 零动作,行为与旧版直连逐字节一致;手编错误
  // (如 socks5://)在此抛双语提示,进程经底部 catch 停下,不留连接超时。
  const proxySettings = applyProxySettings(config);
  if (proxySettings.source !== "none") {
    logger.info(t("proxy.active", { proxy: proxySettings.proxy, source: proxySettings.source }));
  }

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
      matrix.mediaSource,
      // 磁盘类写失败聚合(spec #247 票04):TDZ 闭包次序,recordDiskWriteFailure
      // 声明在 stateDir 区,运行期(首个附件落盘)才被调用。
      (err) => recordDiskWriteFailure("attachment")(err)
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
  // ---- rpc respawn wiring (spec #247 票05) ------------------------------------
  // pi 子进程意外崩溃的自动拉起配置:默认 rpc 与项目子进程共用同一包装类,
  // 两个接线点同款注入 —— 项目进程自动获得同款自愈。达上限的告警经管理房
  // 下发(文案双表,标签区分默认/项目进程)。
  const rpcRespawn = {
    limit: rpcRespawnLimit(config),
    onGiveUp: (broken: PiRpc) => {
      const mgmtRoom = managementRoomId(store.get());
      if (!mgmtRoom || !matrix?.isConnected) return;
      void sendReplyStrict(
        mgmtRoom,
        t("resilience.rpcRespawnGaveUp", {
          label: broken.label ?? t("resilience.rpcLabelDefault"),
          count: String(rpcRespawnLimit(config)),
        })
      ).catch(() => {});
    },
  };
  const rpc = new PiRpc({
    cliPath,
    cwd: workdir,
    args: rpcArgs,
    // 组合根传参(票 #202-#206 评审收尾):生产主路径把已加载的 config 交给
    // RPC 层,spawn 点不再自读配置盘;loadConfig 兜底只留给其他入口自洽。
    proxyConfig: config,
    // bash 自管通道等待上限(票 #220):config bashTimeoutMinutes 派生注入。
    bashTimeoutMs: bashTimeoutMinutes(config) * 60_000,
    respawn: rpcRespawn,
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
    baseOptions: {
      cliPath,
      args: ["--continue"],
      proxyConfig: config,
      bashTimeoutMs: bashTimeoutMinutes(config) * 60_000,
      respawn: rpcRespawn,
    },
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
  // 发送内核(票 #210 评审收尾):失败必须抛出 —— 上线欢迎卡靠它把失败
  // 带进 /pmctl new 的管理房回执附注;其余调用方一律经 sendReply 静默。
  const sendReplyStrict = async (chatId: string, text: string): Promise<void> => {
    const provider = matrix;
    if (!provider) throw new Error("Transport matrix not found");
    if (!provider.isConnected) throw new Error("Transport matrix not connected");
    await provider.sendMessage(chatId, text);
  };
  const sendReply = async (chatId: string, transport: string, text: string): Promise<void> => {
    try {
      // transport 参数仅诊断显示(下方日志与错误文案拼贴),不参与 adapter
      // 查找 —— C8 退役注册表后,全文已无按 transport 名寻址的消费方
      // (grep 证实:仅剩字符串插值);签名保留以维持日志口径不变。
      // ExternalMessage.transport 字段本身是路由元数据,照旧携带。
      await sendReplyStrict(chatId, text);
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
  const pmctl = new PmctlController({
    projectManager,
    roomOps,
    store,
    // 上线欢迎卡发送缝(票 #210):/pmctl new 成功后向新项目房发卡。
    // sendReplyStrict 声明在上方,闭包仅在运行期命令处理时触达。
    notifyRoom: sendReplyStrict,
  });

  // ---- durable state (issue #114) --------------------------------------------
  // ~/.pi/pi-courier-state/(0700)收桥的派生状态文件:磁盘是备份,内存是热路径。
  // 配置(pi-courier.json)、Matrix SDK 存储、PID 锁各归 ~/.pi 原位,不迁。
  const stateDir = path.join(CONFIG_DIR, "pi-courier-state");
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    logger.warn(`state dir unavailable (state files degrade to in-memory): ${errorMessage(err)}`);
  }
  // ---- disk write-failure aggregation (spec #247 票04) ------------------------
  // 桥内四条写路径(状态文件/审计/附件/台账)的磁盘类写失败(ENOSPC/EDQUOT)
  // 统一聚合:首条立即告警,之后 5 分钟至多一条。各写路径既有降级契约不变,
  // recorder 只是附加可见性。notify 走 sendReplyStrict(TDZ 闭包次序同上:
  // 构造期不调用,运行期时 sendReplyStrict 已声明)。
  const writeFailures = new WriteFailureRecorder({
    notify: (info) => {
      const mgmtRoom = managementRoomId(store.get());
      if (!mgmtRoom || !matrix?.isConnected) return;
      void sendReplyStrict(
        mgmtRoom,
        t("resilience.writeFailure", { code: info.code, count: String(info.count), sources: info.sources.join("、") })
      ).catch(() => {});
    },
    log: (message) => logger.warn(message),
  });
  const recordDiskWriteFailure =
    (source: string) =>
    (err: unknown): void => {
      try {
        writeFailures.record(source, err);
      } catch {
        // 聚合通道自身失败不放大写路径
      }
    };

  const attachmentsLedger = new JsonStateFile<PersistedAttachmentEntry[]>(
    path.join(stateDir, "pending-attachments.json"),
    [],
    recordDiskWriteFailure("state-file")
  );

  // ---- heartbeat + periodic self-check tick (spec #247 票02) ------------------
  // 周期自检基座:每 tick(默认 30 秒,可配)原子写一个心跳 JSON 到派生
  // 状态目录 —— 外部看门狗(票06/07)判死活与僵死的唯一依据。onTick 接
  // 票04 资源水位守卫(一次 tick 干两件事,定时器不翻倍)。定时器 unref,
  // 不阻碍优雅退出;写失败 fire-and-forget,永不抛。
  const heartbeat = new Heartbeat({
    filePath: path.join(stateDir, "heartbeat.json"),
    intervalMs: heartbeatIntervalSeconds(config) * 1000,
    readDiskFreeBytes: () => diskFreeBytes(workdir),
    onTick: () => resourceGuard.runChecks(),
  });
  heartbeat.start();

  // ---- offline inbox (issue #113):已处理事件台账 -----------------------------
  // JSONL 追加 + 启动压实(7 天窗);首运会话(freshStart)里 stale 维持全丢,
  // 自第二个会话起「stale 且台账没见过」= 离线积压。模式来自 config 派生,
  // off = 与旧版逐字节一致。transport 在装配后回填(与附件仓库同一接缝)。
  const eventLedger = new FileEventLedger(path.join(stateDir, "event-ledger.jsonl"), {
    onDiskWriteFailure: recordDiskWriteFailure("event-ledger"),
  });
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
    onDiskWriteFailure: recordDiskWriteFailure("audit"),
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
    // 活卡聚合接线(spec #235 票4):Matrix transport 的编辑原语(票1:
    // sendMessage 穿出 event_id + editMessage)适配成 router 的可选编辑缝
    // (票2/票3)。未配置 Matrix 时整个不注入 = 聚合禁用,行为与旧版逐字节
    // 一致。transport 参数仅与 sendReply 形状对齐(诊断口径),不参与适配;
    // 编辑与普通消息走同一条 per-room FIFO 发送通道,E2EE 房间由加密层自动
    // 加密,无需特殊处理。
    ...(matrix
      ? {
          sendLiveCard: (chatId: string, transport: string, text: string) => {
            void transport;
            return matrix!.sendMessage(chatId, text);
          },
          editReply: async (chatId: string, transport: string, messageId: string, text: string) => {
            void transport;
            // editMessage 穿出的替换事件 event_id,router 侧无消费方:显式
            // 吞掉保持 editReply 的 Promise<void> 契约。
            await matrix!.editMessage(chatId, messageId, text);
          },
        }
      : {}),
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
      send: async (roomId, text) => {
        // sendMessage 自 #235 票1 起穿出 event_id,此处消费方仍只要完成
        // 语义,显式吞掉返回值保持 Promise<void> 契约。
        await matrix.sendMessage(roomId, text);
      },
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
  // 共享优雅退出链(spec #247 票01):停 pi RPC → 断 transport → 放单实例锁
  // → 退出。信号路径缺省退出码 0,与历史逐字节一致;崩溃守卫(票03)与
  // 磁盘硬阈值(票04)携带非零码走同一条链,重入标志归链持有。
  const shutdownChain = createShutdownChain({
    stopRpc: () => rpc.stop(),
    disconnectAll,
    releaseLock,
    exit: (code) => process.exit(code),
    log: (message) => logger.info(message),
  });
  process.on("SIGTERM", () => void shutdownChain.shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdownChain.shutdown("SIGINT"));
  // Windows delivers Ctrl+Break (and some service-stop handoffs) as SIGBREAK
  // — SIGTERM never arrives there (evaluation 2026-10-13). POSIX defines the
  // signal too, where it essentially never fires; same shutdown path, so
  // registering it is harmless everywhere.
  process.on("SIGBREAK", () => void shutdownChain.shutdown("SIGBREAK"));

  // ---- crash guard (spec #247 票03) ---------------------------------------------
  // L1 全局兜底:未捕获异常/未处理 Promise 拒绝 → 记录死因 → 尽力向管理房
  // 留言(限时 5 秒,失败不追;未配管理房/未连接静默)→ 沿共享退出链非零码
  // 有序退出。notify 里未配管理房/transport 未连接时静默返回,守卫只记日志。
  // 启动链仍由底部 main().catch 护(既有,保持不动);运行期逃逸由守卫接住。
  const crashGuard = createCrashGuard({
    log: (message) => logger.error(message),
    notify: (reason) => {
      const mgmtRoom = managementRoomId(store.get());
      if (!mgmtRoom || !matrix?.isConnected) return Promise.resolve();
      return sendReplyStrict(mgmtRoom, t("crash.notice", { reason }));
    },
    shutdown: shutdownChain.shutdown,
    hardExit: (code) => process.exit(code),
  });
  process.on("uncaughtException", (err) => void crashGuard.handleCrash("uncaughtException", err));
  process.on("unhandledRejection", (reason) => void crashGuard.handleCrash("unhandledRejection", reason));

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
