/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AUDIT_EVENTS, type AuditLog } from "../audit/audit-log.js";
import { handleAdminCommand } from "../auth/admin-commands.js";
import { type ChallengeAuth } from "../auth/challenge-auth.js";
import { LoginManager } from "../auth/headless-login.js";
import { type ConfigStore, inboxMode, managementRoomId } from "../config.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  splitMessage,truncate 
} from "../formatting.js";
import { t } from "../i18n/index.js";
import { isExecuteInput, isIgnoreInput } from "../i18n/parse.js";
import { namespacedId } from "../identity.js";
import { isEnabled, type LeveledLogger, logger } from "../logger.js";
import type { ReminderController } from "../reminders/reminder-clock.js";
import { demoteTrustedUserEverywhere, inviteUserToManagementRoomOnce, inviteUserToSpaceOnce, maybeInitManagementRoom } from "../space.js";
import type { JsonStateFile } from "../state/json-file.js";
import { formatBytes } from "../transports/attachments.js";
import type { RoomOps } from "../transports/interface.js";
import type { ExternalMessage, MessageAttachment, ReplyTarget } from "../types.js";
import {
  type BashTracker,
  clearedQueuesView,
  createBashTracker,
  formatBashReply,
  handleSlashCommand,
  parseBangCommand,
  type QueueSnapshot,
  queueTotal,
  resolveSessionDir,
} from "./command-map.js";
import { ExtensionQuestions, type ExtensionUIRequestView, extensionUiTimeoutMs } from "./extension-questions.js";
import type { PiRpc } from "./pi-rpc.js";
import type { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";
import type { QueueSnapshotStore } from "./queue-snapshots.js";
import { RpcTransientState } from "./rpc-transient-state.js";
import { extractUserText, type MirroredEntry, MirrorManager } from "./session-mirror.js";
import { appendStatusFooter, collectStatusFooter } from "./status-footer.js";

export interface MessageRouterDeps {
  /** Multi-project routing: resolves the PiRpc for a room (default when unmapped). */
  projectManager: ProjectManager;
  auth: ChallengeAuth;
  /** Send a text reply to a chat via a transport (errors swallowed by caller) */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** Best-effort typing indicator (silent no-op when unavailable) */
  sendTyping: (chatId: string, transport: string) => Promise<void>;
  /** Injected config store — the single runtime read/write path. */
  store: ConfigStore;
  /** Room-management capability (Matrix). Optional: absent in single-project
   *  or non-Matrix deployments; only the /pmctl path and management-room
   *  branding consume it. */
  roomOps?: RoomOps;
  /** Multi-project management (/pmctl family): gates + actions in one module. */
  pmctl: PmctlController;
  /** Space-mode gate: while the organizational space is enabled, the
   *  management room is bot-created at startup and first-DM adoption is
   *  reserved for the degraded path (space ensure failed this run). Absent
   *  = always allowed (legacy deployments). */
  managementRoomAdoptionAllowed?: () => boolean;
  /** Headless login (issue #55): owns /login /logout /auth and captures the
   *  answers of in-flight login flows. Injected by tests (mock runtime);
   *  defaults to a real ModelRuntime at pi's standard credential file. */
  login?: LoginManager;
  /** Durable pending-attachment ledger (issue #114): injected by the
   *  composition root, absent in tests/legacy deployments. Injected → the
   *  ledger survives restarts (24h TTL); absent → pure in-memory, byte-for-byte
   *  the pre-#114 behaviour. */
  attachmentsLedger?: JsonStateFile<PersistedAttachmentEntry[]>;
  /** Chat reminders (/remind, issue #117): the ReminderClock (also the
   *  ReminderController). The router binds each command invocation to the
   *  message's room+sender before the command layer sees it. Absent =
   *  /remind replies unavailable. */
  reminders?: ReminderController;
  /** Cross-process queue snapshot store (issue #115 stage 2): every mirror
   *  change for a project-room process lands on disk, and the next service
   *  start reports the lost queue (standalone wires the store + startup
   *  consumption). Absent = no disk persistence; the single-project default
   *  process is excluded inside the sink either way (conservative route —
   *  its binding is a runtime DM and could misdeliver into a stale room). */
  queueSnapshots?: QueueSnapshotStore;
  /** Audit log (issue #124): sensitive actions append one JSONL line each.
   *  The wiring points are pinned by tests via the shared AUDIT_EVENTS
   *  registry. Absent = zero auditing (tests/legacy deployments). */
  audit?: AuditLog;
}

/** Disk shape of one pending-attachment entry (issue #114). An array of
 *  entries — not a keyed map — keeps the `\u0000` ledger-key separator out of
 *  JSON object keys, where it would be hostile to hand editing and to some
 *  JSON tooling. */
export interface PersistedAttachmentEntry {
  chatId: string;
  userId: string;
  /** Epoch ms when the first attachment for this room+sender was parked —
   *  drives the 24h TTL on load. */
  at: number;
  attachments: MessageAttachment[];
}

/**
 * 管道阶段声明(spec #72 票3/C1):顺序约束与消耗语义升格为结构——
 * 每个阶段自述它与授权门、附件待处理清单、pi 进程懒启动的关系,
 * 取代"第 N 级 return 是否消耗清单"式的注释守护。
 */
export interface PipelineStageView {
  name: string;
  /** 在授权门之前运行(自带门禁的命令族)。 */
  preAuth: boolean;
  /** 到达本阶段即消耗附件待处理清单——全管道只有 prompt。 */
  consumesLedger: boolean;
  /** 需要为当前房间解析 pi 进程(懒启动副作用发生在第一次取用)。 */
  needsRpc: boolean;
}

interface StageContext {
  msg: ExternalMessage;
  text: string;
  log: LeveledLogger;
  isAuthorized: boolean;
  isManagementRoom: boolean;
  multiProject: boolean;
  /** 懒解析 pi 进程:第一次取用才 spawn,失败回执并抛 RPC_ABORT。 */
  roomRpc: () => Promise<PiRpc>;
}

export interface MessageRouter {
  /** Handle an incoming messenger message */
  handleIncoming(msg: ExternalMessage): Promise<void>;
  /** 管道阶段视图(spec #72 票3/C1):顺序即执行顺序,属性即不变量——
   *  供测试钉住"阶段表",供导航时一眼读出管道形状。 */
  pipeline(): PipelineStageView[];
  /** Handle an agent event emitted by `rpc` — the reply target comes from
   *  the rpc's binding (see RoomBinding), never from a global slot. */
  handleEvent(rawEvent: unknown, rpc: PiRpc): void;
  /** 房间消亡销账(/pmctl rm 确认后由组合根经 PmctlController.onRoomRemoved
   *  调用):清掉该房间的停车附件并落盘,返回条数。 */
  purgeRoomAttachments(roomId: string): number;
}

/**
 * Reply routing: every pi process is bound to the chat that prompted it.
 * Project rpcs are pinned to their owning room (re-bound here with the real
 * transport/username); the shared default rpc is re-bound by each DM prompt.
 * Because bindings are per-process, a project-room prompt can never misroute
 * a DM reply — the b7a5d7f bug class dies structurally. Cross-conversation
 * attribution inside ONE shared process is a protocol limit (pi's RPC has no
 * chat concept), so the default rpc's binding legitimately follows the most
 * recent prompter.
 */
interface RoomBinding {
  /** Pinned bindings (project rooms) survive completed turns; the shared
   *  default rpc's binding releases after one. */
  pinned: boolean;
  replyTarget: ReplyTarget;
}

/** Format a completed turn into reply text. Returns text = null when the turn
 *  has no replyable content (the binding is kept for the follow-up turn).
 *  Error turns (stopReason "error") always yield replyable text — the failure
 *  line rides along even when the model produced no content (issue #52). */
export function buildTurnReply(
  message: AssistantMessage,
  hideToolCalls?: boolean
): { text: string | null; pendingTools: boolean } {
  const responseText = extractTextFromMessage(message);
  const toolCallsText = formatToolCalls(message);
  const pendingTools = hasToolCalls(message);
  const parts: string[] = [];
  const trimmed = responseText.trim();
  if (trimmed) parts.push(trimmed);
  if (toolCallsText && !hideToolCalls) parts.push(toolCallsText);
  // Error visibility (issue #52): a turn ending with stopReason "error" must
  // reach the room even when the model produced no text — the text=null path
  // used to swallow failed turns silently (holding an unpinned binding
  // forever). Partial content survives; the failure line rides along.
  if (message.stopReason === "error") {
    parts.push(t("router.turn.failed", { message: message.errorMessage ?? t("common.unknownError") }));
  }
  if (parts.length === 0) return { text: null, pendingTools };
  return { text: parts.join("\n\n"), pendingTools };
}

/**
 * Extension UI 提问机(spec #99 票3 / issue #104):extension_ui_request 的
 * 接纳、FIFO 队列、答案解析、超时代答与重启失效整体住在
 * ./extension-questions.ts(ExtensionQuestions,模块形状对照 LoginManager)。
 * router 只编排 —— handleEvent 的事件路径与 extensionCapture 管道阶段调用
 * 它;提问文案、答案映射与超时时长(extensionUiTimeoutMs)等纯函数也随迁,
 * 供模块测试直测。
 */

/**
 * Reply-quote prefix (issue #56 票5; #124 来源标注): when a message replies
 * to a known historical message, prepend a labeled one-line excerpt so the
 * agent can resolve "这个"/"上面那个" AND can tell third-party content
 * (data) from live instructions — the quote says whose words these are.
 * Only the text sent to pi changes — slash-command detection runs earlier
 * on the raw text and stays untouched.
 */
export function withQuotePrefix(
  text: string,
  quoted?: { username: string; excerpt: string }
): string {
  if (!quoted?.excerpt) return text;
  return `${t("router.quote.prefix", { user: quoted.username, excerpt: quoted.excerpt })}\n${text}`;
}

/**
 * 附件路径注入(issue #66 票1;#124 来源标注):把待处理清单里的附件以绝对
 * 路径列表的形式放在用户原文前 — pi 按原生工作流用 read 工具查看文件(与
 * TUI 的 @路径 一致)。带来源时标注「谁在哪个房间发的」,让 agent(和人)
 * 一眼分辨第三方内容与指令(纵深防御的廉价层)。纯函数,router 测试直接
 * 断言其输出。
 */
export function withAttachmentPrefix(
  text: string,
  attachments?: MessageAttachment[],
  source?: { user: string; room: string }
): string {
  if (!attachments?.length) return text;
  const lines = attachments.map((a) => `- ${a.path}`);
  const header = source
    ? t("router.attach.inject.sourced", { user: source.user, room: source.room })
    : t("router.attach.inject");
  return `${header}\n${lines.join("\n")}\n\n${text}`;
}

/** 附件清单的记账键:房间 + 发送者(群聊里甲的图不被乙的消息消耗)。 */
export function attachmentLedgerKey(chatId: string, userId: string): string {
  return `${chatId}\u0000${userId}`;
}

/** 保存成功回执(issue #66 票1):路径可见,清单状态不静默。 */
export function attachmentSavedReply(attachment: MessageAttachment): string {
  return t("router.attach.saved", { path: attachment.path, bytes: formatBytes(attachment.bytes) });
}

/** 附件失败回执:transport 给出的原因原样透传(下载/解密/超限各有文案)。 */
export function attachmentErrorReply(reason: string): string {
  return `❌ ${reason}`;
}

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const { projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, managementRoomAdoptionAllowed } = deps;
  const bindings = new WeakMap<PiRpc, RoomBinding>();
  const bindReplyTarget = (rpc: PiRpc, replyTarget: ReplyTarget, pinned: boolean): void => {
    bindings.set(rpc, { pinned, replyTarget });
  };

  // 瞬态状态(spec #72 票6/C5):队列镜像 + 悬置提问,失效时机自治 ——
  // 状态模块订阅 PiRpc 的重启生命周期,不再有外借的 clearRpcState 扳机。
  // 非自愿队列丢失回执(issue #115 阶段1):作废时镜像非空 → 向该进程绑定
  // 的房间发「N 条未执行」清单(渲染与 #112 的被清列表同款);绑定不存在
  // (绑定前就重启的极端时序)只打日志,不抛。
  // 跨进程快照落盘(issue #115 阶段2):镜像每次变化(含作废时的权威空)
  // 经 persistQueueMirror 进/出磁盘;服务级重启后由 standalone 启动装载
  // 补发。只覆盖项目进程(多工程保守路线):默认进程的绑定是运行时 DM,
  // 还原到旧房间有过期误发风险 —— roomForRpc 查不到就整段跳过。
  const persistQueueMirror = (rpc: PiRpc, snapshot: QueueSnapshot): void => {
    const snapshots = deps.queueSnapshots;
    if (!snapshots) return;
    const roomId = projectManager.roomForRpc(rpc);
    if (!roomId) return;
    try {
      snapshots.save(roomId, snapshot);
    } catch (err) {
      logger.warn(`queue snapshot persist failed (memory mirror stays authoritative): ${(err as Error).message}`);
    }
  };
  const transient = new RpcTransientState(
    (rpc, handler) => rpc.onRestarted?.(handler),
    (rpc, snapshot) => {
      const view = clearedQueuesView(snapshot);
      if (!view) return;
      const target = bindings.get(rpc)?.replyTarget;
      if (!target) {
        logger.warn(`queue lost on restart: ${view.count} message(s) had no bound room — notice dropped`);
        return;
      }
      void sendReply(target.chatId, target.transport, t("queue.lost.notice", view));
    },
    persistQueueMirror
  );

  // 审计 trails(issue #124):敏感动作的统一记账口 —— 谁在哪个房间干了什么。
  // actor 取 namespaced 身份(与信任/管理员判定同键);detail 一行以内,
  // 由调用点裁剪。未注入 = 零审计,行为与现状逐字节一致。
  const auditTrail = (event: string, msg: ExternalMessage, detail?: string): void => {
    deps.audit?.append(event, namespacedId(msg.userId, msg.transport), msg.chatId, detail);
  };
  const auditDetailOf = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 120);

  // 待处理附件清单(issue #66 票1):按 房间+发送者 记账。消耗规则:该发送
  // 者在同一条管道里真正发给 pi 的下一条对话消息(prompt 唯一注入点)一次性
  // 带上全部并清空;管理命令、登录/extension-ui 应答捕获都在注入点之前
  // return,天然不消耗。
  const pendingAttachments = new Map<string, MessageAttachment[]>();
  // 首次停车时间(落盘 TTL 的依据,issue #114):只记第一次,后来追加的附件
  // 不顺延 —— 挂了 24h 没被消费的条目在下次启动装载时过期。
  const parkedAt = new Map<string, number>();

  // 落盘账本(issue #114):磁盘只做备份,内存 Map 仍是唯一热路径(ConfigStore
  // 单写者哲学)。注入 ledger 则启动装载一次(24h TTL,过期/残缺条目静默跳过),
  // 记账与消耗两处变更后原子落盘;写失败仅 warn(内存仍是权威,退回 0.3.8
  // 行为)。不注入 = 纯内存,行为与 0.3.8 逐字节一致。
  const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;
  if (deps.attachmentsLedger) {
    const now = Date.now();
    let restored = 0;
    for (const entry of deps.attachmentsLedger.load()) {
      if (!entry || typeof entry.chatId !== "string" || typeof entry.userId !== "string") continue;
      if (!Array.isArray(entry.attachments) || entry.attachments.length === 0) continue;
      if (typeof entry.at !== "number" || now - entry.at > LEDGER_TTL_MS) continue;
      pendingAttachments.set(attachmentLedgerKey(entry.chatId, entry.userId), entry.attachments);
      parkedAt.set(attachmentLedgerKey(entry.chatId, entry.userId), entry.at);
      restored += entry.attachments.length;
    }
    if (restored > 0) {
      logger.info(
        `restored ${restored} parked attachment(s) across ${pendingAttachments.size} room+sender entries from disk`
      );
    }
  }
  const persistLedger = (): void => {
    const ledger = deps.attachmentsLedger;
    if (!ledger) return;
    const entries: PersistedAttachmentEntry[] = [];
    for (const [key, attachments] of pendingAttachments) {
      const sep = key.indexOf("\u0000");
      if (sep <= 0) continue; // malformed key never reaches disk
      entries.push({
        chatId: key.slice(0, sep),
        userId: key.slice(sep + 1),
        at: parkedAt.get(key) ?? Date.now(),
        attachments,
      });
    }
    ledger.save(entries);
  };

  // 在跑 bash 记账(/bashstop 的数据源):/bash 与 `!`/`!!` 共用一份,
  // 按 pi 进程记账,promise 落定自动销账(见 createBashTracker)。
  const bashTracker: BashTracker = createBashTracker();

  // ---- 离线收件箱(issue #113):积压缓冲与结算 -----------------------------
  // transport 只负责判定「这是离线积压」(stale + 台账没见过,带 replayed
  // 标记);缓冲、征询与执行裁决都在 router —— 因为授权门控(静默群/未信任
  // 发送者)只有这里有,积压绝不构成越权旁路。per-room 一套:缓冲、结算
  // 计时器(首条积压后 5s,等回放波灌完)与 confirm 待答状态互不串房。
  const BACKLOG_SETTLE_MS = 5_000;
  const BACKLOG_CONFIRM_TIMEOUT_MS = 10 * 60_000;
  const backlogBuffers = new Map<string, ExternalMessage[]>();
  const backlogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const backlogAwaiting = new Map<string, { entries: ExternalMessage[]; timer: ReturnType<typeof setTimeout> }>();

  /** 积压清单的一行预览:文本收成单行截断;非文本载荷与 📥 日志同形。 */
  const backlogPreview = (msg: ExternalMessage): string => {
    const raw = msg.payload.kind === "text" ? msg.payload.text : `[${msg.payload.kind}]`;
    const oneLine = raw.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
  };

  const bufferBacklog = (msg: ExternalMessage): void => {
    const buffer = backlogBuffers.get(msg.chatId) ?? [];
    buffer.push(msg);
    backlogBuffers.set(msg.chatId, buffer);
    if (!backlogTimers.has(msg.chatId)) {
      backlogTimers.set(
        msg.chatId,
        setTimeout(() => settleBacklog(msg.chatId), BACKLOG_SETTLE_MS)
      );
    }
  };

  /** 按到达序原样再注入(剥掉 replayed 标记 = 按实时消息走全管道:斜杠
   *  命令、附件停车、prompt 各归其位)。router 变量在返回后才可用,这里
   *  只在调用时解引用,无 TDZ 问题。 */
  const deliverBacklog = async (entries: ExternalMessage[]): Promise<void> => {
    for (const entry of entries) {
      const { replayed: _strip, ...realtime } = entry;
      await router.handleIncoming(realtime);
    }
  };

  const settleBacklog = (chatId: string): void => {
    const timer = backlogTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      backlogTimers.delete(chatId);
    }
    const entries = backlogBuffers.get(chatId);
    if (!entries || entries.length === 0) return;
    backlogBuffers.delete(chatId);
    const lines = entries.map((e) => t("inbox.entry.line", { user: e.username, preview: backlogPreview(e) })).join("\n");
    const transport = entries[0]!.transport;

    if (inboxMode(store.get()) === "auto") {
      // 告知后直接按序执行(部署者明确选择过;`!`/bash 类消息的惊吓风险
      // 由部署者自担)。
      void sendReply(chatId, transport, t("inbox.auto.notice", { count: entries.length, lines }))
        .then(() => deliverBacklog(entries))
        .catch((err: unknown) => logger.error(`backlog auto-delivery failed: ${(err as Error).message}`));
      return;
    }

    // confirm(默认):汇总征询,「执行」按序处理 /「忽略」丢弃 / 超时视为
    // 忽略。新积压波并入旧待答(重开一轮计时与征询,列表合并展示)。
    const prior = backlogAwaiting.get(chatId);
    if (prior) {
      clearTimeout(prior.timer);
      prior.entries.push(...entries);
    }
    const merged = prior?.entries ?? entries;
    const mergedLines = merged
      .map((e) => t("inbox.entry.line", { user: e.username, preview: backlogPreview(e) }))
      .join("\n");
    const confirmTimer = setTimeout(() => {
      // 超时默认忽略:静默丢弃,不发补充通知(征询文案已写明规则)。
      backlogAwaiting.delete(chatId);
    }, BACKLOG_CONFIRM_TIMEOUT_MS);
    backlogAwaiting.set(chatId, { entries: merged, timer: confirmTimer });
    void sendReply(
      chatId,
      transport,
      t("inbox.confirm.prompt", {
        count: merged.length,
        lines: mergedLines,
        minutes: BACKLOG_CONFIRM_TIMEOUT_MS / 60_000,
      })
    ).catch((err: unknown) => {
      // 征询发不出去(极端时序)等于没人能批准 —— 按忽略处理,积压不留悬案。
      backlogAwaiting.delete(chatId);
      clearTimeout(confirmTimer);
      logger.warn(`backlog confirm prompt failed, backlog discarded: ${(err as Error).message}`);
    });
  };


  // Headless login (issue #55): /login /logout /auth + answer capture. The
  // default manager writes credentials straight to pi's auth.json via an
  // independent ModelRuntime (never through the RPC subprocesses).
  const login =
    deps.login ??
    new LoginManager({
      sendReply,
      allRpcs: () => projectManager.allRpcs(),
    });

  // Extension-UI 提问机(spec #99 票3 / issue #104):状态(FIFO 队列 + 超时
  // 计时器)与不变量都在模块里;router 只注入出口 —— 发帖、extension_ui 应答
  // 写入口、超时时长派生与重启生命周期订阅(与瞬态状态同一接缝)。
  const questions = new ExtensionQuestions({
    sendReply,
    respond: (rpc, payload) => rpc.respondExtensionUI(payload),
    timeoutMs: () => extensionUiTimeoutMs(store.get()),
    subscribeRestart: (rpc, handler) => rpc.onRestarted?.(handler),
  });

  // TUI ↔ Matrix 会话镜像(/attach /detach):显示靠 tail + 去重,上下文靠
  // prompt 前自动接力 —— 机制都在 session-mirror.ts,router 只做渲染、目标
  // 绑定与接力时机编排。
  const mirrors = new MirrorManager();

  /** /attach:开启当前房间对本进程会话目录的镜像,返回给房间的说明文案。 */
  const attachMirror = async (rpc: PiRpc, target: ReplyTarget): Promise<string> => {
    const client = rpc.requireClient();
    const state = await client.getState();
    if (!state.sessionFile || !state.sessionId) {
      return t("cmd.attach.noSession");
    }
    // 初始 leaf(分叉检测的基线):失败容忍 —— null 时第一条 tail entry 不判
    // 分叉,只建立基线,之后的断裂仍会被发现。
    let leafId: string | null = null;
    try {
      leafId = (await client.getEntries()).leafId;
    } catch {
      // get_entries 不可用时按未知 leaf 起步(见上)。
    }
    const dir = resolveSessionDir(rpc);
    // 权威源自写判定:上游普通消息落盘不发 entry_appended,文件层分不出两端,
    // 疑似外部写入时直接问 RPC 进程(get_entries 的 id 集合)。
    const querySelfEntryIds = async (): Promise<Set<string>> => {
      const { entries } = await rpc.requireClient().getEntries();
      return new Set(entries.map((e) => e.id));
    };
    mirrors.attach(rpc, dir, {
      onExternalMessage: (entry) => mirrorForward(entry, target),
      onFork: () => {
        sendReply(target.chatId, target.transport, t("mirror.fork.warning")).catch(() => {});
      },
      onForeignSession: (file) => {
        sendReply(target.chatId, target.transport, t("mirror.newSession.notice", { file })).catch(() => {});
      },
    }, leafId, state.sessionFile, querySelfEntryIds);
    // 附加命令用会话文件路径而非 id:实测 pi 1.0 的 id 查找在本布局下不可靠
    // (get_state 的 sessionId 与文件 header id 在 resume 后会漂移,且按 id 查
    // 两者都 No session found;路径模式直开文件,永远有效)。--session-dir 保
    // 持与本进程同源,用户后续 /new 时新会话落在同一目录,镜像照常覆盖。
    const attachCommand = `pi${rpc.sessionDir ? ` --session-dir ${rpc.sessionDir}` : ""} --session '${state.sessionFile}'`;
    return t("cmd.attach.ok", { command: attachCommand, dir });
  };

  /**
   * TUI 写入的对话消息 → 渲染转发房间。两类消息都带角色前缀:Matrix 里全部
   * 由 bot 账号发出,不加前缀就无法区分「TUI 里的人说的话」和「TUI 里的
   * agent 回复」。只转对话文本:工具循环中间消息无文本时 buildTurnReply 给
   * text=null,自然跳过(hideToolCalls 恒 true)。镜像链路任何异常不影响主流程。
   */
  const mirrorForward = (entry: MirroredEntry, target: ReplyTarget): void => {
    try {
      if (entry.role === "user") {
        const text = extractUserText(entry.message);
        if (text) {
          sendReply(target.chatId, target.transport, t("mirror.user", { text: truncate(text, 3000) })).catch(() => {});
        }
        return;
      }
      if (entry.role === "assistant") {
        const turn = buildTurnReply(entry.message as AssistantMessage, true);
        if (turn.text) {
          sendReply(target.chatId, target.transport, t("mirror.assistant", { text: truncate(turn.text, 3000) })).catch(() => {});
        }
      }
    } catch {
      // 镜像渲染失败静默:显示是附加能力,不影响会话与转发主链路。
    }
  };

  // ── 管道阶段(spec #72 票3/C1)─────────────────────────────────────
  // 顺序即执行顺序。每个阶段的 handle 返回 true = 消息已被处理(管道终止)。
  // 不变量:consumesLedger=true 的阶段有且仅有 prompt(附件待处理清单的
  // 唯一消耗点);preAuth=true 的阶段自带门禁,在授权门之前运行。
  const RPC_ABORT = Symbol("rpc-abort");

  const stages: Array<PipelineStageView & { handle: (ctx: StageContext) => Promise<boolean> }> = [
    {
      name: "authorization",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Authorization (initiates 6-digit challenge for unknown users in DMs):
      // computing it has the side effect of the challenge flow, so it runs for
      // every message — even for preAuth stages above that ignore the result.
      handle: async (ctx) => {
        ctx.isAuthorized = await auth.checkAuthorization(
          ctx.msg.userId,
          ctx.msg.chatId,
          ctx.msg.username,
          ctx.msg.isGroupChat,
          ctx.msg.wasMentioned ?? false,
          async (cId, replyText) => sendReply(cId, ctx.msg.transport, replyText),
          ctx.msg.transport
        );
        return false;
      },
    },
    {
      name: "attachments",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 附件/失败/不支持载荷的分流:必须在斜杠/挑战码解析之前截住 — 文件名
      // 可能碰巧以 "/" 或 6 位数字开头。回执是 router 政策:未授权用户与
      // 文本消息同等对待(静默丢弃,文件已落盘但不入清单)。
      handle: async (ctx) => {
        if (ctx.msg.payload.kind === "text") return false;
        if (!ctx.isAuthorized) return true;
        switch (ctx.msg.payload.kind) {
          case "mediaError":
            await sendReply(ctx.msg.chatId, ctx.msg.transport, attachmentErrorReply(ctx.msg.payload.reason));
            return true;
          case "unsupported":
            await sendReply(
              ctx.msg.chatId,
              ctx.msg.transport,
              t("router.payload.unsupported", { msgtype: ctx.msg.payload.msgtype })
            );
            return true;
          case "media": {
            const key = attachmentLedgerKey(ctx.msg.chatId, ctx.msg.userId);
            const ledger = pendingAttachments.get(key) ?? [];
            for (const attachment of ctx.msg.payload.saved) {
              ledger.push(attachment);
              await sendReply(ctx.msg.chatId, ctx.msg.transport, attachmentSavedReply(attachment));
            }
            pendingAttachments.set(key, ledger);
            parkedAt.set(key, parkedAt.get(key) ?? Date.now());
            persistLedger();
            return true;
          }
        }
      },
    },
    {
      name: "adminCommands",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // Bridge admin commands + challenge codes in DMs. /help is reserved
      // for pi (the RPC command help also lists bridge commands).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (msg.isGroupChat || (!text.startsWith("/") && !/^\d{6}$/.test(text))) return false;
        const cmdName = text.split(/\s+/)[0].toLowerCase();
        if (text.startsWith("/") && cmdName === "/help") return false;
        const result = handleAdminCommand(auth, {
          text,
          userId: msg.userId,
          transport: msg.transport,
          chatId: msg.chatId,
          hideToolCalls: store.get().hideToolCalls,
        });
        if (!result.handled) return false;
        // 审计(issue #124):纯模块裁决事件名,router 落账 —— 认证与信任
        // 面(配对成败、/trusted、/revoke)在唯一入口处一次记全。
        if (result.audit) {
          auditTrail(result.audit.event, msg, result.audit.detail);
        }
        for (const replyText of result.replies) {
          await sendReply(msg.chatId, msg.transport, replyText);
        }
        for (const notification of result.notifications) {
          logger.info(`[auth:${notification.level}] ${notification.message}`);
        }
        for (const effect of result.effects) {
          if (effect.kind === "persistAuth") {
            store.update({ auth: auth.exportConfig() });
          } else if (effect.kind === "hideToolCalls") {
            store.update({ hideToolCalls: effect.value });
          } else if (effect.kind === "spaceInvite" && roomOps) {
            // Trust just granted (challenge passed): invite into the
            // organizational space — fire-once, best-effort (see space.ts).
            await inviteUserToSpaceOnce(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          } else if (effect.kind === "managementRoomInvite" && roomOps) {
            // Trust just granted: the management room (/pmctl home) must be
            // reachable too — fire-once, best-effort, space mode only; the
            // degraded path's adopted DM is never used to pull people in.
            await inviteUserToManagementRoomOnce(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          } else if (effect.kind === "powerDemote" && roomOps) {
            // Trust just revoked (ticket 3): strip the admin power this
            // instance once granted — every managed room, PL 0. Best-effort
            // like the invite effects: failures warn and stay in the
            // powerElevatedUsers bookkeeping for the startup heal to retry;
            // the revoke itself stands either way.
            await demoteTrustedUserEverywhere(
              roomOps,
              store,
              namespacedId(effect.userId, effect.transport)
            );
          }
        }
        return true;
      },
    },
    {
      name: "groupEnable",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // Group chats: a trusted user can enable the current room without
      // knowing its ID — send "/enable <mode>" right in the room. This must
      // run BEFORE authorization (unenabled rooms are not authorized).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!msg.isGroupChat || !text.startsWith("/enable")) return false;
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) return false;
        const parts = text.split(/\s+/);
        const mode = (parts[1] || "trusted-only") as "all" | "mentions" | "trusted-only";
        if (mode !== "all" && mode !== "mentions" && mode !== "trusted-only") {
          await sendReply(msg.chatId, msg.transport, t("router.enable.usage"));
          return true;
        }
        // "all" responds to everyone — admin-only. Trusted users may only
        // request trusted-only / mentions.
        if (mode === "all" && !auth.isAdminUser(msg.userId, msg.transport)) {
          await sendReply(msg.chatId, msg.transport, t("router.enable.allAdminOnly"));
          return true;
        }
        auth.enableChannel(msg.chatId, mode);
        store.update({ auth: auth.exportConfig() });
        await sendReply(msg.chatId, msg.transport, t("router.enable.ok", { mode }));
        logger.info(`[auth] room ${msg.chatId} enabled by ${msg.username} (${mode})`);
        return true;
      },
    },
    {
      name: "authorizationGate",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Unauthorized senders stop here, silently — same treatment as text.
      handle: async (ctx) => !ctx.isAuthorized,
    },
    {
      name: "backlogAnswer",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 离线积压征询的应答消费(issue #113):房间有待答征询时,「执行/
      // 忽略」在此截住(不得漏到 pi 当对话);其它输入照常走管道,征询
      // 继续挂着等。授权已在上一阶段裁决 —— 未信任者的应答根本到不了这。
      handle: async (ctx) => {
        if (!ctx.text) return false;
        const pending = backlogAwaiting.get(ctx.msg.chatId);
        if (!pending) return false;
        if (isExecuteInput(ctx.text)) {
          backlogAwaiting.delete(ctx.msg.chatId);
          clearTimeout(pending.timer);
          const entries = pending.entries;
          // 审计(issue #124,#113 回填):离线积压批量执行是运行时突变 —
          // 谁、在哪个房间、放行了几条,一行留痕。
          auditTrail(AUDIT_EVENTS.backlogExecute, ctx.msg, `delivering ${entries.length} offline backlog message(s)`);
          void deliverBacklog(entries).catch((err: unknown) =>
            logger.error(`backlog delivery failed: ${(err as Error).message}`)
          );
          return true;
        }
        if (isIgnoreInput(ctx.text)) {
          backlogAwaiting.delete(ctx.msg.chatId);
          clearTimeout(pending.timer);
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("inbox.ignored", { count: pending.entries.length }));
          return true;
        }
        return false;
      },
    },
    {
      name: "backlogInbox",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 离线积压缓冲(issue #113):replayed 消息不直接执行,按房间攒着,
      // 首条积压后 5s(等回放波灌完)或本房间首条实时消息到达时结算。
      // off 模式 transport 根本不转发积压;这里再挡一道(手喂消息的兜底)。
      handle: async (ctx) => {
        if (ctx.msg.replayed) {
          if (inboxMode(store.get()) === "off") return false;
          bufferBacklog(ctx.msg);
          return true;
        }
        if (backlogBuffers.has(ctx.msg.chatId)) settleBacklog(ctx.msg.chatId);
        return false;
      },
    },
    {
      name: "multiproject",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // /multiproject — switch single/multi project mode. Config read/write;
      // takes effect on restart. Trusted users may toggle.
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!text.startsWith("/multiproject")) return false;
        const isTrusted = auth.isTrustedUser(msg.userId, msg.transport);
        if (!isTrusted) {
          await sendReply(msg.chatId, msg.transport, t("router.multiproject.forbidden"));
          return true;
        }
        const action = text.split(/\s+/)[1]?.toLowerCase() ?? "";
        const current = projectManager.isMultiProject ? t("router.multiproject.currentOn") : t("router.multiproject.currentOff");
        if (action === "on" || action === "off") {
          const next = action === "on";
          if (next === projectManager.isMultiProject) {
            await sendReply(msg.chatId, msg.transport, t("router.multiproject.noChange", { current }));
            return true;
          }
          store.update({ multiProject: next });
          await sendReply(
            msg.chatId,
            msg.transport,
            t("router.multiproject.switched", {
              state: next ? t("common.enabled") : t("common.disabled"),
              detail: next ? t("router.multiproject.detailOn") : t("router.multiproject.detailOff"),
            })
          );
        } else {
          await sendReply(msg.chatId, msg.transport, t("router.multiproject.usage", { current }));
        }
        return true;
      },
    },
    {
      name: "managementAdoption",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Management room = the FIRST accepted message in a private (≤2 person)
      // non-project room fixes that room's ID (managementRooms[0]). Works for
      // BOTH challenge-code pairing and config-driven trusted users. Only in
      // multi-project mode.
      handle: async (ctx) => {
        if (
          ctx.multiProject &&
          roomOps &&
          (managementRoomAdoptionAllowed?.() ?? true) &&
          !managementRoomId(store.get()) &&
          !ctx.msg.isGroupChat &&
          !projectManager.isProjectRoom(ctx.msg.chatId)
        ) {
          await maybeInitManagementRoom(ctx.msg, sendReply, roomOps, store);
        }
        ctx.isManagementRoom = ctx.multiProject && managementRoomId(store.get()) === ctx.msg.chatId;
        return false;
      },
    },
    {
      name: "roomBinding",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Resolve + bind the room's pi process (post-gate — old behaviour):
      // extension_ui questions and agent events route back through the
      // RoomBinding, so every conversational/management message that reaches
      // here must leave the room bound. Unmapped rooms resolve to the running
      // default rpc (no spawn); mapped project rooms start theirs exactly as
      // they always did.
      handle: async (ctx) => {
        await ctx.roomRpc();
        return false;
      },
    },
    {
      name: "pmctl",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // /pmctl family: gates + actions live in the controller. The invite
      // target arrives pre-resolved (transport-native MXID). No pi process
      // is started for management commands.
      handle: async (ctx) => {
        // 审计(issue #124):项目删除是最重的一刀,确认链的每一步都留痕
        //(/pmctl rm 与其确认词都命中这里);其余子命令 v1 不记。
        if (/^\/pmctl\s+rm(\s|$)/i.test(ctx.text.trim())) {
          auditTrail(AUDIT_EVENTS.pmctlRemove, ctx.msg, auditDetailOf(ctx.text));
        }
        return await pmctl.handle(ctx.text, { chatId: ctx.msg.chatId, senderMxid: ctx.msg.userId, isManagementRoom: ctx.isManagementRoom }, async (replyText) => sendReply(ctx.msg.chatId, ctx.msg.transport, replyText));
      },
    },
    {
      name: "login",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Headless login (issue #55): /login /logout /auth — admin + management
      // room only. Single-project mode has no management room: a DM counts as
      // one (that is where the admin talks to the bot there).
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!/^\/(login|logout|auth)(\s|$)/.test(text)) return false;
        // 审计(issue #124):认证面 —— 放行与否都记(被拒的尝试更要留痕)。
        auditTrail(AUDIT_EVENTS.loginFlow, msg, auditDetailOf(text));
        const loginRoomAllowed = ctx.multiProject
          ? ctx.isManagementRoom
          : !msg.isGroupChat;
        if (!auth.isAdminUser(msg.userId, msg.transport)) {
          await sendReply(msg.chatId, msg.transport, t("router.login.forbidden"));
          return true;
        }
        if (!loginRoomAllowed) {
          await sendReply(msg.chatId, msg.transport, t("router.login.roomRestricted"));
          return true;
        }
        const loginCmd = text.split(/\s+/)[0]!.toLowerCase();
        const loginArgs = text.slice(loginCmd.length).trim();
        if (loginCmd === "/login") {
          if (!loginArgs) {
            await login.listProviders(msg.chatId, msg.transport);
          } else {
            const [providerId, method] = loginArgs.split(/\s+/);
            await login.startLogin(msg.chatId, msg.transport, providerId!, method);
          }
          return true;
        }
        if (loginCmd === "/logout") {
          if (!loginArgs) {
            await sendReply(msg.chatId, msg.transport, t("router.login.logoutUsage"));
            return true;
          }
          await login.logout(msg.chatId, msg.transport, loginArgs.split(/\s+/)[0]!);
          return true;
        }
        await login.authStatus(msg.chatId, msg.transport);
        return true;
      },
    },
    {
      name: "slashCommands",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Slash commands → RPC mapping (builtin) or passthrough (extensions/
      // skills/templates). Unhandled slashes fall through to the prompt —
      // pi expands its own commands/skills/templates.
      handle: async (ctx) => {
        if (!ctx.text.startsWith("/")) return false;
        const rpc = await ctx.roomRpc();
        try {
          const handled = await handleSlashCommand(ctx.text, {
            rpc,
            reply: async (replyText) => sendReply(ctx.msg.chatId, ctx.msg.transport, replyText),
            queueView: () => transient.mirror(rpc),
            setQueueMirror: (snapshot) => transient.setMirror(rpc, snapshot),
            allRpcs: () => projectManager.allRpcs(),
            bashTracker,
            // 审计缝(issue #124):命令层只报「发生了什么」,落账仍在 router
            //(/stop //interrupt 的真实清队、/bash 的 shell 执行由此上报)。
            audit: (event, detail) => auditTrail(event, ctx.msg, detail),
            // /remind(issue #117):命令层不接触 chatId/userId —— 这里按本消息
            // 的房间与发起人预先绑定。
            reminders: deps.reminders
              ? {
                  add: (text, dueAt) =>
                    deps.reminders!.add({
                      chatId: ctx.msg.chatId,
                      transport: ctx.msg.transport,
                      userId: ctx.msg.userId,
                      username: ctx.msg.username,
                      text,
                      dueAt,
                    }),
                  list: () => deps.reminders!.listForRoom(ctx.msg.chatId),
                  removeByIndex: (index) => deps.reminders!.removeByIndex(ctx.msg.chatId, index),
                }
              : undefined,
            sessionMirror: {
              attach: async () => attachMirror(rpc, { chatId: ctx.msg.chatId, transport: ctx.msg.transport, username: ctx.msg.username }),
              detach: async () =>
                mirrors.detach(rpc) ? t("cmd.detach.ok") : t("cmd.detach.notActive"),
              active: () => mirrors.has(rpc),
              rebase: (sessionFile) => mirrors.rebase(rpc, sessionFile),
              currentSessionFile: async () => (await rpc.requireClient().getState()).sessionFile,
            },
          });
          // 审计(issue #124):命令面按登记表落账 —— 只记敏感动作
          //(/bash /bashstop /reload;清队走上面的 audit 缝,由命令层
          // 按真实语义上报)。handled=false 的未识别斜杠不记。
          if (handled) {
            const cmdName = ctx.text.trim().split(/\s+/)[0]!.toLowerCase();
            if (cmdName === "/bash") auditTrail(AUDIT_EVENTS.bashExec, ctx.msg, auditDetailOf(ctx.text));
            else if (cmdName === "/bashstop") auditTrail(AUDIT_EVENTS.bashStop, ctx.msg, auditDetailOf(ctx.text));
            else if (cmdName === "/reload") auditTrail(AUDIT_EVENTS.reload, ctx.msg, auditDetailOf(ctx.text));
          }
          return handled;
        } catch (err) {
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("cmd.generic.error", { message: (err as Error).message }));
          return true;
        }
      },
    },
    {
      name: "bashBang",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!):收到即回执,完成(或被
      // /bashstop 中止)后回帖结果。不等待完成 —— 长命令不阻塞管道,后续
      // 消息照常处理;记账进 bashTracker 供 /bashstop 列出/中止。
      handle: async (ctx) => {
        const bang = parseBangCommand(ctx.text);
        if (!bang) return false;
        const rpc = await ctx.roomRpc();
        // 审计(issue #124):shell 快捷执行是危险面的正门,进出都留痕。
        auditTrail(AUDIT_EVENTS.bashExec, ctx.msg, `${bang.excluded ? "!!" : "!"} ${bang.command}`);
        const release = bashTracker.track(rpc, bang.command);
        void sendReply(
          ctx.msg.chatId,
          ctx.msg.transport,
          t("router.bang.inProgress", { command: bang.command, suffix: bang.excluded ? t("cmd.bash.excludedNote") : "" })
        ).catch(() => {});
        rpc.bash(bang.command, { excludeFromContext: bang.excluded })
          .then((result) => sendReply(ctx.msg.chatId, ctx.msg.transport, formatBashReply(bang.command, result, bang.excluded)))
          .catch((err: unknown) =>
            sendReply(ctx.msg.chatId, ctx.msg.transport, t("cmd.bash.error", { message: (err as Error).message }))
          )
          .catch(() => {})
          .finally(release);
        return true;
      },
    },
    {
      name: "loginCapture",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Answer capture for plain (non-"/") messages: login flows (issue #55)
      // capture FIRST — while a login waits in this room its answer wins over
      // any pending extension_ui question (ticket requirement); 「取消」 aborts
      // the login at any moment. Messages arriving between prompts (OAuth
      // polling) are NOT consumed — the room stays usable during long waits.
      handle: async (ctx) => {
        if (ctx.text.startsWith("/")) return false;
        return login.isPending(ctx.msg.chatId) && (await login.deliver(ctx.msg.chatId, ctx.text));
      },
    },
    {
      name: "extensionCapture",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // Pending extension_ui questions are answered by the room's next plain
      // message (issue #54). The 提问机 owns the FIFO and its invariants; an
      // unconsumed message (no pending question / another room's question is
      // oldest) falls through to the prompt.
      handle: async (ctx) => {
        if (ctx.text.startsWith("/")) return false;
        const rpc = await ctx.roomRpc();
        return questions.deliver(rpc, ctx.text, ctx.msg, ctx.log);
      },
    },
    {
      name: "prompt",
      preAuth: false,
      consumesLedger: true,
      needsRpc: true,
      // Plain message → prompt (a resolved reply quote is prepended — see
      // withQuotePrefix; command handling above saw the raw text). Pending
      // attachments (issue #66 票1) ride along here and ONLY here: the unique
      // consumption point for the per-room+sender ledger. The ledger is
      // cleared only after the send succeeded — a failed prompt keeps the
      // attachments parked so the retry carries them.
      handle: async (ctx) => {
        const rpc = await ctx.roomRpc();
        // 自动接力(镜像 /attach 生效时):发 prompt 前若 TUI 有未接力的写入
        // 且进程空闲,先 switchSession 重读会话文件,agent 带着全量上下文作答。
        // 失败只警告不阻断;busy/forked/clean 静默(forked 已在 onFork 警告过)。
        try {
          const relay = await mirrors.ensureFreshContext(rpc);
          if (relay.kind === "failed") {
            await sendReply(ctx.msg.chatId, ctx.msg.transport, t("mirror.relay.failed", { message: relay.message }));
          }
        } catch {
          // 接力检查的任何意外不得挡住 prompt 本身。
        }
        try {
          const key = attachmentLedgerKey(ctx.msg.chatId, ctx.msg.userId);
          const carried = pendingAttachments.get(key);
          const pending = carried?.length ? carried : undefined;
          const quoted = ctx.msg.payload.kind === "text" ? ctx.msg.payload.quoted : undefined;
          // 来源标注(issue #124):附件与引用进 prompt 时带「谁发的」——
          // 第三方内容以数据身份入上下文,不冒充指令。
          await rpc.prompt(
            withAttachmentPrefix(withQuotePrefix(ctx.text, quoted), pending, {
              user: ctx.msg.userId,
              room: ctx.msg.chatId,
            })
          );
          pendingAttachments.delete(key);
          parkedAt.delete(key);
          persistLedger();
        } catch (err) {
          if (err === RPC_ABORT) throw err;
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("router.prompt.failed", { message: (err as Error).message }));
        }
        return true;
      },
    },
  ];

  const router: MessageRouter = {
    /** 管道阶段表:顺序即执行顺序(导航入口,直测面见 pipeline())。 */
    pipeline(): PipelineStageView[] {
      return stages.map(({ name, preAuth, consumesLedger, needsRpc }) => ({ name, preAuth, consumesLedger, needsRpc }));
    },

    /** 房间销账(/pmctl rm 确认后由组合根调用):清掉该房间全部停车附件并
     *  落盘,返回条数。房间删除后其清单条目已无人能消费 —— 意图随房间销账,
     *  不等 24h TTL 自然过期。 */
    purgeRoomAttachments(roomId: string): number {
      let removed = 0;
      for (const key of [...pendingAttachments.keys()]) {
        if (key.slice(0, key.indexOf("\u0000")) === roomId) {
          pendingAttachments.delete(key);
          parkedAt.delete(key);
          removed++;
        }
      }
      if (removed > 0) persistLedger();
      return removed;
    },

    async handleIncoming(msg: ExternalMessage): Promise<void> {
      const text = msg.payload.kind === "text" ? msg.payload.text.trim() : "";
      // 空文本本身直接返回 — 非文本载荷(附件/失败/不支持)必须继续走,
      // 否则就是又一个静默吞消息的点(issue #66 票3)。
      if (msg.payload.kind === "text" && !text) return;

      // Project tagging (spec #34): a mapped room's lines carry its label;
      // everything else (single-project mode, DM, unmapped rooms) resolves to
      // undefined = the plain logger, byte-identical to the old output.
      const label = projectManager.labelForRoom(msg.chatId);
      const log = logger.withLabel(label);

      const payloadSummary = msg.payload.kind === "text" ? text : `[${msg.payload.kind}]`;
      if (isEnabled("debug")) {
        log.debug(`📥 [${msg.transport}] @${msg.username}: ${payloadSummary.slice(0, 500)}${payloadSummary.length > 500 ? "…" : ""}`);
      } else {
        log.info(`📥 [${msg.transport}] @${msg.username}: ${payloadSummary.slice(0, 200)}${payloadSummary.length > 200 ? "…" : ""}`);
      }

      let rpcOnce: Promise<PiRpc> | undefined;
      const ctx: StageContext = {
        msg,
        text,
        log,
        isAuthorized: false,
        isManagementRoom: false,
        multiProject: projectManager.isMultiProject,
        roomRpc: () => {
          // 懒解析(spec #72 票3):pi 进程只为真正需要它的阶段启动——
          // 命令族(附件/pmux 管理命令/登录)不触发 spawn。失败回执后以
          // RPC_ABORT 静默终止管道(通用错误由 standalone 兜底)。
          rpcOnce ??= Promise.resolve(projectManager.getRpcForRoom(msg.chatId)).then((rpc) => {
            // Per-process binding (see RoomBinding above) — resolution time is
            // the natural bind point: project rooms pin, the shared default
            // rpc follows its latest prompter.
            bindReplyTarget(
              rpc,
              { chatId: msg.chatId, transport: msg.transport, username: msg.username },
              projectManager.isProjectRoom(msg.chatId)
            );
            return rpc;
          }).catch((err: unknown) => {
            void sendReply(msg.chatId, msg.transport, t("router.rpc.startFailed", { message: (err as Error).message }));
            throw RPC_ABORT;
          });
          return rpcOnce;
        },
      };

      try {
        for (const stage of stages) {
          if (await stage.handle(ctx)) return;
        }
      } catch (err) {
        if (err !== RPC_ABORT) throw err;
      }
    },

    handleEvent(rawEvent: unknown, rpc: PiRpc): void {
      // The reply target comes from the rpc's own binding — project rpcs are
      // pinned to their room, the default rpc follows its latest prompter.
      const target = bindings.get(rpc)?.replyTarget;

      // Tagged view: a project rpc's events all carry its label; the default
      // rpc's do not (rpc.label is undefined there — spec #34).
      const log = logger.withLabel(rpc.label);

      // extension_error is emitted by the RPC layer but is not part of the
      // typed AgentSessionEvent union — widen for runtime event checking.
      const event = rawEvent as AgentEventView;


      logAgentEvent(event, log);

      // Refresh the queue mirror before any routing decisions — /queue and the
      // stop/interrupt queue warning read this snapshot.
      if (event.type === "queue_update") {
        transient.setMirror(rpc, {
          steering: [...(event.steering ?? [])],
          followUp: [...(event.followUp ?? [])],
        });
      }

      // Extension UI (issue #54): questions are asked in the bound room and
      // parked for the next plain message to answer; notify is presented by
      // level; TUI-only display methods are ignored. 提问机模块自持队列与
      // 超时计时器(spec #99 票3 / issue #104)。
      if (event.type === "extension_ui_request") {
        questions.handle(rawEvent as ExtensionUIRequestView, rpc, target, log);
        return;
      }

      if (event.type === "turn_start") {
        if (target) {
          sendTyping(target.chatId, target.transport).catch(() => {});
        }
        return;
      }

      if (event.type === "turn_end") {
        if (!target) return;
        const turn = buildTurnReply(event.message as AssistantMessage, store.get().hideToolCalls);

        // Reply summary at INFO level — the full conversation is also in pi's
        // session file.
        const replyPreview = turn.text ?? "";
        log.info(`[agent] reply to @${target.username}: ${replyPreview.slice(0, 500)}${replyPreview.length > 500 ? "…" : ""}`);

        if (turn.text === null) {
          // No content this turn — keep the binding for a follow-up turn
          return;
        }

        const chunks = splitMessage(turn.text, 4000);
        // 回复末尾状态脚注:仅收敛终答(pendingTools=false)挂 —— 工具循环
        // 中间消息不挂(否则 N 步任务挂 N 条);失败回复(stopReason=error)
        // 与正文同路,一并携带。数据现拉现用(collectStatusFooter 永不抛,
        // 失败段显示 '?'),多片长文只挂最后一片。fire-and-forget:终答因此
        // 改为异步出站,但下方绑定释放保持同步原位,不等派发落账。
        const dispatch = async (): Promise<void> => {
          let outgoing = chunks;
          if (!turn.pendingTools) {
            const footer = await collectStatusFooter(rpc);
            outgoing = chunks.map((chunk, index) =>
              index === chunks.length - 1 ? appendStatusFooter(chunk, footer) : chunk
            );
          }
          for (const chunk of outgoing) {
            sendReply(target.chatId, target.transport, chunk).catch(() => {});
          }
        };
        void dispatch();

        // A completed conversational turn releases unpinned bindings (the
        // shared default rpc) so late events never reply to a stale chat.
        // Pinned project bindings survive (parity with the old roomId path).
        const binding = bindings.get(rpc);
        if (!turn.pendingTools && binding && !binding.pinned) {
          bindings.delete(rpc);
        }
        return;
      }

      // Error visibility (issue #52): auto-retry progress reaches the room so
      // a failing round is never silent. Same guard as turn_start's typing:
      // only with a live binding (logAgentEvent above already logs both).
      if (event.type === "auto_retry_start") {
        if (target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.retry.inProgress", {
              attempt: event.attempt ?? "?",
              max: event.maxAttempts ?? "?",
              error: summarizeArg(event.errorMessage, 200) || t("common.unknownError"),
            })
          ).catch(() => {});
        }
        return;
      }

      // Retries exhausted: the final error goes to the room; a successful
      // retry (success === true) needs no reply — the turn continues normally.
      if (event.type === "auto_retry_end") {
        if (event.success !== true && target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.retry.exhausted", { error: summarizeArg(event.finalError, 300) || t("common.unknownError") })
          ).catch(() => {});
        }
        return;
      }

      if (event.type === "extension_error") {
        log.error(`[agent] extension error (${event.extensionPath ?? "unknown"}): ${event.error ?? "unknown"}`);
        if (target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.extensionError", { path: event.extensionPath ?? "unknown", error: event.error ?? "unknown" })
          ).catch(() => {});
        }
      }
    },
  };
  return router;
}

/** Compact one-line summary of a streamed delta event (thinking/text/tool deltas). */
function summarizeStreamDelta(event: {
  assistantMessageEvent?: unknown;
  message?: AssistantMessage;
}): string {
  const e = event.assistantMessageEvent as
    | { type?: string; text?: string; thinking?: string; delta?: string; toolCall?: unknown }
    | undefined;
  if (!e) return "(no delta)";
  if (e.type === "text" && e.text) return e.text.slice(0, 300);
  if (e.type === "thinking" && e.thinking) return `thinking: ${e.thinking.slice(0, 300)}`;
  if (e.type === "tool_call") return "tool call delta";
  if (e.delta) return e.delta.slice(0, 300);
  return `(${e.type ?? "unknown"})`;
}

type AgentEventView = {
        type: string;
        message?: AssistantMessage;
        assistantMessageEvent?: unknown;
        toolName?: string;
        args?: unknown;
        result?: unknown;
        partialResult?: unknown;
        isError?: boolean;
        willRetry?: boolean;
        attempt?: number;
        maxAttempts?: number;
        delayMs?: number;
        errorMessage?: string;
        finalError?: string;
        success?: boolean;
        reason?: string;
        aborted?: boolean;
        level?: unknown;
        name?: string;
        steering?: readonly string[];
        followUp?: readonly string[];
        extensionPath?: string;
        error?: string;
     };

/**
 * Session-replay logging, fully separated from routing: muting it (log
 * level, or removing calls) can never affect reply routing.
 */
function logAgentEvent(event: AgentEventView, log: LeveledLogger): void {
  switch (event.type) {
    case "agent_start":
      log.debug("[agent] run started");
      break;
    case "agent_end":
      log.debug(`[agent] run finished (willRetry: ${event.willRetry ?? false})`);
      break;
    case "agent_settled":
      log.debug("[agent] settled");
      break;
    case "message_start":
      log.debug("[agent] message started");
      break;
    case "message_update":
      // Streaming delta (includes thinking deltas). DEBUG level, truncated.
      log.debug(`[agent] stream delta: ${summarizeStreamDelta(event)}`);
      break;
    case "message_end":
      log.debug("[agent] message completed");
      break;
    case "tool_execution_start":
      log.info(`[agent] 🔧 tool call: ${event.toolName ?? "?"}(${summarizeArg(event.args)})`);
      break;
    case "tool_execution_update":
      log.debug(`[agent] tool progress: ${event.toolName ?? "?"} → ${summarizeArg(event.partialResult, 300)}`);
      break;
    case "tool_execution_end":
      log.info(
        `[agent] tool done: ${event.toolName ?? "?"} → ${event.isError ? "❌ error" : "✅ ok"} ${summarizeArg(event.result, 500)}`
      );
      break;
    case "compaction_start":
      log.warn(`[agent] compaction started (${event.reason ?? "?"})`);
      break;
    case "compaction_end":
      log.warn(
        `[agent] compaction ${event.aborted ? "aborted" : "finished"} (${event.reason ?? "?"}${event.errorMessage ? `, error: ${event.errorMessage}` : ""})`
      );
      break;
    case "auto_retry_start":
      log.warn(`[agent] auto-retry ${event.attempt}/${event.maxAttempts}(${event.errorMessage ?? ""})`);
      break;
    case "auto_retry_end":
      log.warn(`[agent] auto-retry finished: ${event.success ? "ok" : `failed (${event.finalError ?? ""})`}`);
      break;
    case "queue_update":
      log.debug(`[agent] queue updated (steer: ${event.steering?.length ?? 0}, followUp: ${event.followUp?.length ?? 0})`);
      break;
    case "thinking_level_changed":
      log.info(`[agent] thinking level: ${String(event.level ?? "?")}`);
      break;
    case "session_info_changed":
      log.debug(`[agent] session name: ${event.name ?? "(cleared)"}`);
      break;
    case "entry_appended":
      log.debug("[agent] session entry written");
      break;
    default:
      log.debug(`[agent] event: ${event.type}`);
      break;
  }
}

/**
 * 管理房收养(spec #99 票3 / issue #104):maybeInitManagementRoom 迁到
 * space.ts 侧 —— 收养是管理房的空间侧语义,与 startup ensure 的自建路径同址;
 * router 的 managementAdoption 阶段只调用,管理房判定走 config 的
 * managementRoomId 派生、收养写走 adoptManagementRoom。
 */
function summarizeArg(arg: unknown, max = 500): string {
  if (arg === undefined || arg === null) return "";
  if (typeof arg === "string") {
    const s = arg.replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }
  try {
    const s = JSON.stringify(arg);
    if (!s) return "";
    const oneLine = s.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  } catch {
    return String(arg);
  }
}
