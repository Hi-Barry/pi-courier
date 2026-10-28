/**
 * /update 热更新编排器(桥自更新 spec §5):进程内单例状态机
 * idle → checking → (waiting) → installing → (restart-pending) → idle。
 *
 * handler 返回契约与同步段固定顺序(§5.3,硬契约):case "/update" 的
 * handleCommand 同步段按固定顺序执行,全部零 await ——
 *   ① 子命令分派(check/cancel):分派先于占位 —— check 只读不占位;
 *      cancel 在任何态都须可处理(占位先行会让 waiting/checking 态的
 *      cancel 撞 inProgress 被误杀,取消功能整体失效)。
 *   ② 同步守卫链(root → 管理房 → 参数):全部先于占位 —— 拒绝路径根本
 *      未占位、零残留,拒绝后 /update 可立即再次发起。
 *   ③ 编排分支(无参/force)执行同步 CAS 占位(idle → checking,失败 =
 *      已有编排 → inProgress 拒绝)。占位必须先于一切 await:管道对并发
 *      斜杠命令无串行化(每条消息独立 await handleSlashCommand),探测与
 *      fetch 都有 await 窗口,占位晚了会双编排、双 npm spawn。
 * 占位后的一切 await 包在 try 内,任何异常先同步复位 idle 再上抛(让
 * router 的 generic catch 接手该条消息的回执);预告回执完成后立即返回
 * true,等待/安装/重启由后台循环驱动(void 挂起,不 await 进命令调用栈),
 * 后续回执经预绑定的发起房间缝(io.reply)异步发送,后台循环自身异常自捕
 * 不外抛。cancel 的判定与置位同步完成于一切 await 之前(§5.7)。
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { fetch as undiciFetch } from "undici";
import { AUDIT_EVENTS } from "../audit/audit-log.js";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import {
  AllAgentsIdleTimeoutError,
  type AllAgentsProbe,
  probeAllAgents,
  type WaitForAllAgentsIdleOptions,
  waitForAllAgentsIdle,
} from "../rpc/command-map.js";
import type { PiRpc } from "../rpc/pi-rpc.js";
import { serviceManagementSupported } from "../systemd-hint.js";
import { readBridgeVersion } from "../version.js";
import type { PendingUpdateStore } from "./pending-update.js";
import { runUpgrade, type UpgradeOutcome } from "./upgrade.js";

export const UPDATE_WAIT_TIMEOUT_MS = 30 * 60_000;
export const UPDATE_WAIT_PROGRESS_MS = 5 * 60_000;

/** systemd 单元名(cli.ts:36 SERVICE_NAME 同款,单元由 pi-courier enable 安装)。 */
const SERVICE_NAME = "pi-courier";
const REGISTRY_LATEST_URL = "https://registry.npmjs.org/pi-courier/latest";
const REGISTRY_TIMEOUT_MS = 10_000;

/** npm dist-tag 端点的超时缝同款信号形态。 */
export type RegistryFetch = (url: string, init: { signal: AbortSignal }) => Promise<unknown>;

export type UpdateState = "idle" | "checking" | "waiting" | "installing" | "restart-pending";
export type UpdateSubcommand = "check" | "cancel" | "force" | "none" | "invalid";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 子命令分派(§5.3 顺序①):"" → none;其余精确匹配;其他一律 invalid
 *  (参数铁律:版本号/URL/路径/git ref 一律拒绝,唯一来源锁死 npm latest)。 */
export function classifyUpdateArgs(args: string): UpdateSubcommand {
  const normalized = args.trim().toLowerCase();
  if (normalized === "") return "none";
  if (normalized === "check" || normalized === "force" || normalized === "cancel") return normalized;
  return "invalid";
}

/** registry 响应 → latest 版本号:必须匹配 x.y.z 才返回(防注入:该值后面
 *  要拼进回执文案);校验失败 = 检查失败(§5.2)。 */
export function parseLatestVersion(body: unknown): string | undefined {
  const version =
    body !== null && typeof body === "object" ? (body as { version?: unknown }).version : undefined;
  return typeof version === "string" && VERSION_RE.test(version) ? version : undefined;
}

/** 数字三段比较:candidate ≤ current → 无新版。前置守卫:两参都必须已通过
 *  x.y.z 校验(不满足返回 false),比较按数字展开,不存在 NaN 路径。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  if (!VERSION_RE.test(candidate) || !VERSION_RE.test(current)) return false;
  const [cMajor, cMinor, cPatch] = candidate.split(".").map(Number) as [number, number, number];
  const [uMajor, uMinor, uPatch] = current.split(".").map(Number) as [number, number, number];
  if (cMajor !== uMajor) return cMajor > uMajor;
  if (cMinor !== uMinor) return cMinor > uMinor;
  return cPatch > uPatch;
}

/**
 * /update 的命令 IO:全部由 router 的 slashCommands 阶段按本消息预绑定
 * (reminders 先例)—— 命令层不接触 chatId/userId,后台循环持有本缝,
 * 预告/进度/升级与重启各回执一律发往发起时捕获的原房间(§11.9)。
 */
export interface UpdateCommandIO {
  reply: (text: string) => Promise<void>;
  /** 管理房语境(router 按 login 先例计算:multiProject ? isManagementRoom
   *  : !isGroupChat;单工程 DM 即管理房,§4)。 */
  adminRoom: boolean;
  /** 全实例 rpc 全集(默认进程 + 已启动项目进程);后台循环每次现取。 */
  allRpcs: () => PiRpc[];
  /** 审计缝(ctx.audit;actor/chatId 由 router 闭包绑定原发起人)。 */
  audit?: (event: string, detail?: string) => void;
}

export interface UpdateOrchestratorDeps {
  /** npm registry fetch 缝(默认 undici fetch + 10s 超时;必须用 undici 的
   *  实现 —— 经 proxy.ts 换装的全局调度器,出网代理自动生效,§11.8)。 */
  fetchRegistry?: RegistryFetch;
  /** 当前版本缝(默认 readBridgeVersion:每次现读磁盘,npm 升级后返回新值
   *  —— from 必须在 installing 开始前捕获,不得事后重读,§11.1)。 */
  readVersion?: () => string | undefined;
  /** root 判定缝(默认 process.getuid?.();Windows 无 getuid → undefined
   *  自然放行,§5.1)。 */
  getuid?: () => number | undefined;
  /** 平台缝(serviceManagementSupported 的入参;systemd 判定用)。 */
  platform?: NodeJS.Platform;
  /** 全实例忙闲探测缝(默认 command-map 的 probeAllAgents)。 */
  probe?: (rpcs: readonly PiRpc[]) => Promise<AllAgentsProbe>;
  /** 全实例空闲等待缝(默认 command-map 的 waitForAllAgentsIdle)。 */
  waitForIdle?: (rpcs: readonly PiRpc[], options: WaitForAllAgentsIdleOptions) => Promise<void>;
  /** 升级执行缝(默认 runUpgrade;参数仅为测试断言便利)。 */
  upgrade?: (from: string, to: string) => Promise<UpgradeOutcome>;
  /** systemctl --user is-active 前置探测缝(默认真实 spawn;任何失败安全
   *  默认 false —— 非 active 单元上 restart 会拉起单元、新实例撞 PID 锁
   *  立即退出,留下 failed 单元而旧版进程继续服务,§5.5 步骤 3)。 */
  systemctlActive?: () => Promise<boolean>;
  /** 重启触发缝(默认 detached systemctl restart,必须脱离父进程存活)。 */
  triggerRestart?: () => void;
  /** pending-update.json 落盘缝(回执闭环凭据;写入可感知失败,§5.5)。 */
  pendingUpdate: PendingUpdateStore;
  /** 等待上限 / 进度间隔(默认 30min / 5min;测试注入短值)。 */
  waitTimeoutMs?: number;
  waitProgressMs?: number;
}

async function defaultRegistryFetch(url: string, init: { signal: AbortSignal }): Promise<unknown> {
  const response = await undiciFetch(url, init);
  return await response.json();
}

/** systemctl --user is-active 前置探测(cli.ts wasActive 门同款,异步 spawn
 *  + promise);systemctl 不存在/探测失败 → false(安全默认,降级手动重启)。 */
async function defaultSystemctlActive(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn("systemctl", ["--user", "is-active", SERVICE_NAME]);
    } catch {
      resolve(false);
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk: string | Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(out.trim() === "active"));
  });
}

function defaultTriggerRestart(): void {
  // 必须 detached + unref:restart 会杀死本进程,spawn 须脱离父进程存活
  // (§11.3 —— 不脱离可能在 kill 到来前抛 EBUSY/中断)。
  nodeSpawn("systemctl", ["--user", "restart", SERVICE_NAME], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export class UpdateOrchestrator {
  private state: UpdateState = "idle";
  /**
   * 编排代次:状态机每发生一次转移 +1;后台循环闭包捕获自己进入时的代次,
   * 后续每次转移/取消都使旧循环自废 —— cancel(同步置位)与后台超时回执的
   * 仲裁依据,防止迟到置位打回 idle 造出双编排窗口(§5.7)。
   */
  private generation = 0;
  private from?: string;
  private to?: string;
  private startedAt = 0;
  private lastProgressAt = 0;

  constructor(private readonly deps: UpdateOrchestratorDeps) {}

  /** 当前状态(组合根日志与测试断言用)。 */
  get currentState(): UpdateState {
    return this.state;
  }

  private get waitTimeoutMs(): number {
    return this.deps.waitTimeoutMs ?? UPDATE_WAIT_TIMEOUT_MS;
  }

  private get waitProgressMs(): number {
    return this.deps.waitProgressMs ?? UPDATE_WAIT_PROGRESS_MS;
  }

  private get waitMinutes(): number {
    return Math.round(this.waitTimeoutMs / 60_000);
  }

  /**
   * /update 命令处理(含 §5.3 同步段固定顺序)。返回 true = 已处理
   * (含 unavailable/守卫拒绝);同步守卫拒绝与占位失败零残留。
   */
  async handleCommand(args: string, io: UpdateCommandIO): Promise<boolean> {
    // ── 同步段(§5.3 固定顺序,零 await)────────────────────────────────
    // ① 子命令分派(先于占位)。
    const sub = classifyUpdateArgs(args);
    // ② 同步守卫链:root → 管理房 → 参数,全部先于占位(拒绝未占位、零残留)。
    if (sub !== "check" && this.deps.getuid?.() === 0) {
      // root 拒执行(§5.1):防 npm postinstall 提权;check 只读豁免。
      await io.reply(t("cmd.update.rootDenied"));
      return true;
    }
    if (!io.adminRoom) {
      await io.reply(t("cmd.update.notManagementRoom"));
      return true;
    }
    if (sub === "invalid") {
      await io.reply(t("cmd.update.rejectedArgs"));
      return true;
    }
    if (sub === "cancel") return await this.cancel(io);
    if (sub === "check") return await this.check(io);
    // ③ 编排分支(无参/force):同步 CAS 占位 idle → checking。
    if (this.state !== "idle") {
      await io.reply(t("cmd.update.inProgress"));
      return true;
    }
    this.state = "checking";
    this.generation += 1;
    const myGen = this.generation;
    const from = (this.deps.readVersion ?? readBridgeVersion)(); // 现读磁盘,fetch 前先取并判空(§5.2)
    this.startedAt = Date.now();
    // ── 占位后的 await 段:一切异常先同步复位 idle 再上抛(占位释放契约)──
    try {
      if (from === undefined) {
        this.state = "idle";
        await io.reply(t("cmd.update.check.failed", { message: "current bridge version unavailable" }));
        return true;
      }
      this.from = from;
      let latest: string | undefined;
      try {
        latest = await this.fetchLatest();
      } catch (err) {
        this.state = "idle";
        await io.reply(t("cmd.update.check.failed", { message: errorMessage(err) }));
        return true;
      }
      if (latest === undefined) {
        this.state = "idle";
        await io.reply(t("cmd.update.check.failed", { message: "registry latest version missing or malformed" }));
        return true;
      }
      if (!isNewerVersion(latest, from)) {
        this.state = "idle";
        await io.reply(t("cmd.update.check.upToDate", { version: from }));
        return true;
      }
      this.to = latest;
      const probe = await this.probe(io.allRpcs());
      if (sub !== "force" && (probe.streaming > 0 || probe.unreachable > 0)) {
        // 忙(或查不动)且非 force → waiting:预告 + 后台等待(§5.3)。
        this.state = "waiting";
        await io.reply(this.waitingAnnouncement(probe));
        void this.waitThenInstall(io, myGen, from, latest);
        return true;
      }
      // 真全空闲,或 force(force 恒跳过等待直接 installing;重启另有
      // restart-pending 空闲确认兜底)。
      this.state = "installing";
      this.generation += 1;
      await io.reply(t("cmd.update.started", { from, to: latest }));
      void this.installAndAwaitRestart(io, this.generation, from, latest);
      return true;
    } catch (err) {
      // 占位释放契约(§5.3):先同步复位 idle 再上抛,让 generic catch 接手
      // 本条消息的回执 —— 漏复位会让状态机永久卡 checking(防线 7 反向锁死)。
      this.state = "idle";
      this.generation += 1;
      throw err;
    }
  }

  /** check 子命令:只读查询,自身不占位、不 CAS(§5.7),任何态都可发。 */
  private async check(io: UpdateCommandIO): Promise<boolean> {
    try {
      const from = (this.deps.readVersion ?? readBridgeVersion)();
      if (from === undefined) {
        await io.reply(t("cmd.update.check.failed", { message: "current bridge version unavailable" }));
        return true;
      }
      let latest: string | undefined;
      try {
        latest = await this.fetchLatest();
      } catch (err) {
        await io.reply(t("cmd.update.check.failed", { message: errorMessage(err) }));
        return true;
      }
      if (latest === undefined) {
        await io.reply(t("cmd.update.check.failed", { message: "registry latest version missing or malformed" }));
        return true;
      }
      if (!isNewerVersion(latest, from)) {
        await io.reply(t("cmd.update.check.upToDate", { version: from }));
        return true;
      }
      await io.reply(t("cmd.update.check.hasNew", { from, to: latest }));
      return true;
    } catch (err) {
      // fetch 之后的意外失败统一落检查失败文案(check 不改状态机,无释放负担)。
      await io.reply(t("cmd.update.check.failed", { message: errorMessage(err) }));
      return true;
    }
  }

  /**
   * cancel 子命令:分派先于占位(不被 CAS 误杀);判定与置位同步完成于
   * 一切 await 之前 —— 先同步读态 → 同步置位,之后才 await 回执/写文件
   * (§5.7:迟到置位会把状态机打回 idle,第二条 /update 随即启动第二套编排)。
   */
  private cancel(io: UpdateCommandIO): Promise<boolean> {
    switch (this.state) {
      case "idle":
      case "checking":
        // checking 还没结论、无等待可取消(check 结束即释放占位)。
        return this.replyTrue(io, t("cmd.update.noPending"));
      case "installing":
        // 换血窗口不可中断、无回滚路径,状态不变(§5.7)。
        return this.replyTrue(io, t("cmd.update.inProgress"));
      case "waiting": {
        this.state = "idle";
        this.generation += 1;
        return (async () => {
          await io.reply(t("cmd.update.cancelled"));
          io.audit?.(AUDIT_EVENTS.updateCancel, "waiting cancelled by /update cancel");
          return true;
        })();
      }
      case "restart-pending": {
        // 已换血,取消的只是自动重启这半步,不回滚:文件照写(手动重启后
        // 照样闭环回执)+ manualRestartHint + audit → idle(§5.5 失败分支
        // 同一出口)。此处写失败不阻断任何事,manualRestartHint 照发。
        this.state = "idle";
        this.generation += 1;
        return (async () => {
          this.writePendingUpdateBestEffort();
          await io.reply(t("cmd.update.manualRestartHint", { from: this.from ?? "unknown", to: this.to ?? "unknown" }));
          io.audit?.(AUDIT_EVENTS.updateCancel, "restart wait cancelled by /update cancel");
          return true;
        })();
      }
    }
  }

  // ── 后台循环(void 挂起,不占命令调用栈;自身异常自捕不外抛)──────────

  /** waiting 段:等全空闲 → installing(§5.3)。 */
  private async waitThenInstall(io: UpdateCommandIO, myGen: number, from: string, to: string): Promise<void> {
    try {
      await this.waitIdleWithProgress(io, myGen, "waiting");
    } catch (err) {
      if (!(err instanceof AllAgentsIdleTimeoutError)) {
        // 非超时的等待内部异常:复位可重试,别把它谎报成超时。
        logger.error(`[update] waiting loop failed: ${errorMessage(err)}`);
        if (this.state === "waiting" && this.generation === myGen) {
          this.state = "idle";
          this.generation += 1;
        }
        return;
      }
      if (this.generation !== myGen || this.state !== "waiting") return; // cancel 先到
      // 超时(§5.3):回执 + audit update.cancel → idle(可用 force 重试)。
      this.state = "idle";
      this.generation += 1;
      try {
        await io.reply(t("cmd.update.waitTimeout", { minutes: this.waitMinutes }));
      } catch (replyErr) {
        logger.error(`[update] waitTimeout notice failed: ${errorMessage(replyErr)}`);
        return;
      }
      io.audit?.(AUDIT_EVENTS.updateCancel, "wait timeout");
      return;
    }
    if (this.generation !== myGen || this.state !== "waiting") return; // cancel 先到
    this.state = "installing";
    this.generation += 1;
    try {
      await io.reply(t("cmd.update.started", { from, to }));
    } catch (err) {
      logger.error(`[update] started notice failed: ${errorMessage(err)}`);
      this.state = "idle";
      this.generation += 1;
      return;
    }
    await this.installAndAwaitRestart(io, this.generation, from, to);
  }

  /** installing 段:换血 → 成功进 restart-pending(§5.4 → §5.5)。 */
  private async installAndAwaitRestart(io: UpdateCommandIO, myGen: number, from: string, to: string): Promise<void> {
    let outcome: UpgradeOutcome;
    try {
      const upgrade = this.deps.upgrade ?? (() => runUpgrade());
      outcome = await upgrade(from, to);
    } catch (err) {
      outcome = { ok: false, message: errorMessage(err) };
    }
    if (this.generation !== myGen || this.state !== "installing") return;
    if (!outcome.ok) {
      // 安全失败(§5.4):回执错误、旧版继续运行、桥绝不自杀,状态回 idle。
      this.state = "idle";
      this.generation += 1;
      try {
        await io.reply(t("cmd.update.npmFailed", { message: outcome.message }));
      } catch (err) {
        logger.error(`[update] npmFailed notice failed: ${errorMessage(err)}`);
      }
      return;
    }
    try {
      await io.reply(t("cmd.update.installed", { from, to }));
    } catch (err) {
      logger.error(`[update] installed notice failed: ${errorMessage(err)}`);
      this.state = "idle";
      this.generation += 1;
      return;
    }
    // restart-pending(§5.5):换血已完成,只剩第二段空闲确认(npm 窗口
    // 期间可能有新任务进来)。
    this.state = "restart-pending";
    this.generation += 1;
    const myRestartGen = this.generation;
    try {
      const probe = await this.probe(io.allRpcs());
      if (this.generation !== myRestartGen || this.state !== "restart-pending") return;
      if (probe.streaming > 0 || probe.unreachable > 0) {
        // 忙 → 本态专用预告与进度(restartWait/restartProgress:换血已完成、
        // 只剩等空闲重启,busyWaiting/waitProgress 的「开始更新」措辞在本态
        // 语义错位,§5.5)。
        const base = t("cmd.update.restartWait", { minutes: this.waitMinutes });
        const text =
          probe.unreachable > 0 ? `${base}\n${t("cmd.update.unreachableNote", { count: probe.unreachable })}` : base;
        await io.reply(text);
        try {
          await this.waitIdleWithProgress(io, myRestartGen, "restart-pending");
        } catch (err) {
          if (this.generation !== myRestartGen || this.state !== "restart-pending") return;
          const detail =
            err instanceof AllAgentsIdleTimeoutError
              ? "restart wait timeout"
              : `restart wait loop failed: ${errorMessage(err)}`;
          if (!(err instanceof AllAgentsIdleTimeoutError)) {
            logger.error(`[update] restart wait loop failed: ${errorMessage(err)}`);
          }
          this.finishRestartPendingManually(io, from, to, detail);
          return;
        }
        if (this.generation !== myRestartGen || this.state !== "restart-pending") return;
      }
      await this.restartNow(io, myRestartGen, from, to);
    } catch (err) {
      // 后台循环兜底:绝不外抛(进度回执等 await 的意外失败);状态复位可重试。
      logger.error(`[update] restart-pending phase failed: ${errorMessage(err)}`);
      if (this.state === "restart-pending" && this.generation === myRestartGen) {
        this.state = "idle";
        this.generation += 1;
      }
    }
  }

  /** restart-pending 超时/内部失败出口:文件照写(手动重启照样闭环回执)+
   *  manualRestartHint + audit → idle。此处写失败不阻断任何事(该路径本就
   *  不自动重启),闭环静默缺失仅 warn 留痕(§5.5 失败分支)。 */
  private finishRestartPendingManually(io: UpdateCommandIO, from: string, to: string, detail: string): void {
    this.state = "idle";
    this.generation += 1;
    this.writePendingUpdateBestEffort();
    void io
      .reply(t("cmd.update.manualRestartHint", { from, to }))
      .then(() => {
        io.audit?.(AUDIT_EVENTS.updateCancel, detail);
      })
      .catch((err: unknown) => {
        logger.error(`[update] manualRestartHint notice failed: ${errorMessage(err)}`);
        io.audit?.(AUDIT_EVENTS.updateCancel, detail);
      });
  }

  /**
   * 重启编排(§5.5,顺序即契约):①先写 pending-update.json(可感知成功,
   * 写失败放弃自动重启)→ ②await 回执落定 → ③才触发 detached restart。
   * 反过来的任何一步都会在文件落盘或回执网络往返完成前被 SIGTERM,闭环丢失。
   */
  private async restartNow(io: UpdateCommandIO, myGen: number, from: string, to: string): Promise<void> {
    try {
      this.deps.pendingUpdate.write({ from, to, startedAt: this.startedAt });
    } catch (err) {
      // 写失败 = 完成回执会静默丢失 → 放弃自动重启:降级手动重启,状态回 idle
      // (代码已在磁盘,手动重启加载新版,仅丢完成回执;§5.5 步骤 1)。
      logger.warn(`pending-update.json write failed, automatic restart abandoned: ${errorMessage(err)}`);
      this.state = "idle";
      this.generation += 1;
      try {
        await io.reply(t("cmd.update.manualRestart", { from, to }));
      } catch (replyErr) {
        logger.error(`[update] manualRestart notice failed: ${errorMessage(replyErr)}`);
      }
      return;
    }
    try {
      await io.reply(t("cmd.update.restarting"));
    } catch (err) {
      logger.error(`[update] restarting notice failed: ${errorMessage(err)}`);
      this.state = "idle";
      this.generation += 1;
      return;
    }
    // 只判平台不判 active 会误伤非单元部署(§5.5 步骤 3):两者都满足才 restart。
    const platform = this.deps.platform ?? process.platform;
    let active = false;
    if (serviceManagementSupported(platform)) {
      try {
        active = await this.systemctlActive();
      } catch (err) {
        // is-active 探测失败(systemctl 不存在等)→ 安全默认 false,降级手动重启。
        logger.warn(`[update] systemctl is-active probe failed, degrading to manual restart: ${errorMessage(err)}`);
      }
    }
    if (this.generation !== myGen || this.state !== "restart-pending") return; // cancel 先到
    if (!active) {
      // 非 Linux / 单元非 active / is-active 探测失败(安全默认)→ 降级回执,
      // 不报错(§5.5 步骤 4)。
      this.state = "idle";
      this.generation += 1;
      try {
        await io.reply(t("cmd.update.manualRestart", { from, to }));
      } catch (replyErr) {
        logger.error(`[update] manualRestart notice failed: ${errorMessage(replyErr)}`);
      }
      return;
    }
    try {
      (this.deps.triggerRestart ?? defaultTriggerRestart)();
    } catch (err) {
      // spawn 出错:文件已写,手动 restart 即可(重启后回执闭环);状态复位。
      this.state = "idle";
      this.generation += 1;
      try {
        await io.reply(t("cmd.update.restartFailed", { message: errorMessage(err) }));
      } catch (replyErr) {
        logger.error(`[update] restartFailed notice failed: ${errorMessage(replyErr)}`);
      }
      return;
    }
    // detached spawn 已离开本进程事件循环,进程通常即刻被 systemctl 杀掉;
    // 万一没死(总线失败等),状态回 idle 让 /update 可再次发起 —— 自愈优先,
    // pending-update.json 已在盘上,任何一次重启都会闭环回执。
    this.state = "idle";
  }

  // ── 缝与小件 ───────────────────────────────────────────────────────────

  private async fetchLatest(): Promise<string | undefined> {
    const fetchRegistry = this.deps.fetchRegistry ?? defaultRegistryFetch;
    const body = await fetchRegistry(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    return parseLatestVersion(body);
  }

  private probe(rpcs: readonly PiRpc[]): Promise<AllAgentsProbe> {
    return (this.deps.probe ?? probeAllAgents)(rpcs);
  }

  private systemctlActive(): Promise<boolean> {
    return this.deps.systemctlActive ? this.deps.systemctlActive() : defaultSystemctlActive();
  }

  private async replyTrue(io: UpdateCommandIO, text: string): Promise<boolean> {
    await io.reply(text);
    return true;
  }

  /** 忙时/重启等待的预告文案(N>0 与 N=0&U>0 各专用键,§5.3/§9)。 */
  private waitingAnnouncement(probe: AllAgentsProbe): string {
    if (probe.streaming > 0) {
      const base = t("cmd.update.busyWaiting", { count: probe.streaming, minutes: this.waitMinutes });
      return probe.unreachable > 0 ? `${base}\n${t("cmd.update.unreachableNote", { count: probe.unreachable })}` : base;
    }
    // N=0 且 U>0:查不动的实例不是「可确认的」空闲 —— 主句直说无法确认,
    // 不用 busyWaiting 渲染出「0 个任务在跑,全部完成后自动开始」的自相矛盾。
    return t("cmd.update.waitingUnreachableOnly", { count: probe.unreachable, minutes: this.waitMinutes });
  }

  /** 全实例空闲等待(带 5 分钟进度回报;waiting 与 restart-pending 两态共用
   *  同一原语与参数,进度文案按态分键,§5.3/§5.5)。 */
  private async waitIdleWithProgress(
    io: UpdateCommandIO,
    myGen: number,
    phase: "waiting" | "restart-pending"
  ): Promise<void> {
    const waitForIdle = this.deps.waitForIdle ?? waitForAllAgentsIdle;
    const progressKey = phase === "waiting" ? "cmd.update.waitProgress" : "cmd.update.restartProgress";
    this.lastProgressAt = Date.now();
    await waitForIdle(io.allRpcs(), {
      timeoutMs: this.waitTimeoutMs,
      onTick: (probe) => {
        if (this.generation !== myGen || this.state !== phase) return;
        const elapsed = Date.now() - this.lastProgressAt;
        if (elapsed < this.waitProgressMs) return;
        this.lastProgressAt = Date.now();
        const base = t(progressKey, { count: probe.streaming, minutes: Math.round(elapsed / 60_000) });
        const text =
          probe.unreachable > 0 ? `${base}\n${t("cmd.update.unreachableNote", { count: probe.unreachable })}` : base;
        return io.reply(text).catch((err: unknown) => {
          logger.warn(`[update] progress notice failed: ${errorMessage(err)}`);
        });
      },
      shouldAbort: () => this.generation !== myGen || this.state !== phase,
    });
  }

  /** cancel/超时出口的 pending-update 写入:失败仅 warn,不阻断该出口的回执。 */
  private writePendingUpdateBestEffort(): void {
    if (this.from === undefined || this.to === undefined) return;
    try {
      this.deps.pendingUpdate.write({ from: this.from, to: this.to, startedAt: this.startedAt });
    } catch (err) {
      logger.warn(`pending-update.json write failed (completion notice will be missed): ${errorMessage(err)}`);
    }
  }
}
