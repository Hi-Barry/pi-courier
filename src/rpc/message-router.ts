/**
 * Message router — the core wiring between messenger transports and pi RPC.
 *
 * Shared by the standalone entry (and testable in isolation with a mock transport):
 *   incoming messenger message ──> router ──> RPC command / prompt
 *   agent events ────────────────> router ──> reply back to the messenger
 */

import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AUDIT_EVENTS, type AuditLog } from "../audit/audit-log.js";
import { handleAdminCommand } from "../auth/admin-commands.js";
import { type ChallengeAuth } from "../auth/challenge-auth.js";
import { guestCommandVerdict } from "../auth/guest-policy.js";
import { LoginManager } from "../auth/headless-login.js";
import { BotRegistry } from "../collab/bot-registry.js";
import { ClaimLedger } from "../collab/claim-ledger.js";
import { repoNameFromUrl } from "../collab/git-info.js";
import { RoomMailbox } from "../collab/mailbox.js";
import { commandPolicy } from "../command-registry.js";
import { aggregateToolTurns, bashOutputLimit, type ConfigStore, effectiveWorkdir, managementRoomId, modelFallbackChain, recapOnNew, toolCallArgLimit, WORKFLOW_CARD_DEGRADED_RETRY_MS_DEFAULT, workflowCardThrottleMs, workflowProgressCard } from "../config.js";
import { errorMessage } from "../errors.js";
import {
  extractTextFromMessage,
  formatToolCalls,
  hasToolCalls,
  partitionToolCalls,
  splitMessage,
  truncate,
  truncateLine,
} from "../formatting.js";
import { t } from "../i18n/index.js";
import { namespacedId } from "../identity.js";
import { isEnabled, type LeveledLogger, logger } from "../logger.js";
import { demoteTrustedUserEverywhere } from "../power-heal.js";
import type { ReminderController } from "../reminders/reminder-clock.js";
import { inviteUserToManagementRoomOnce, inviteUserToSpaceOnce, maybeInitManagementRoom } from "../space-topology.js";
import type { JsonStateFile } from "../state/json-file.js";
import { formatBytes } from "../transports/attachments.js";
import type { RoomOps } from "../transports/interface.js";
import type { MatrixReaction } from "../transports/matrix.js";
import type { ExternalMessage, MessageAttachment, ReplyTarget } from "../types.js";
import type { UpdateOrchestrator } from "../update/updater.js";
import { workflowCardLabels } from "../workflow/render.js";
import type { PersistedAttachmentEntry } from "./attachment-ledger.js";
import { AttachmentLedger } from "./attachment-ledger.js";
import { BacklogInbox } from "./backlog-inbox.js";
import { ToolTurnCards, WorkflowProgressCards } from "./card-session.js";
import { handleLoginFamily, handlePmctlFamily, normalizeDetailLine } from "./command-dispatch.js";
import {
  type BashTracker,
  bashTimeoutText,
  clearedQueuesView,
  createBashTracker,
  formatBashPreview,
  formatBashReply,
  handleSlashCommand,
  type McpOrchestration,
  parseBangCommand,
  type QueueSnapshot,
  resolveSessionDir,
} from "./command-map.js";
import { ExtensionQuestions, type ExtensionUIRequestView, extensionUiTimeoutMs } from "./extension-questions.js";
import { FallbackStreak, MODEL_FALLBACK_THRESHOLD, nextFallbackTarget } from "./model-switch.js";
import type { PiRpc } from "./pi-rpc.js";
import type { PmctlController } from "./pmctl-controller.js";
import type { ProjectManager } from "./project-manager.js";
import type { QueueSnapshotStore } from "./queue-snapshots.js";
import { RECAP_MIN_TURNS, RecapBusyError, RecapEmptyError, RecapLedger, recapCardTitle, recapCcPrefix, renderRecapCard } from "./recap.js";
import { RpcRestartHooks } from "./restart-hooks.js";
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
  sendTyping: (chatId: string, transport: string, active?: boolean) => Promise<void>;
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
   *  the pre-#114 behaviour. 磁盘形状与状态机在 attachment-ledger module
   *  (2026-10-27 扫描批次 A),这里只注入存储。 */
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
  /** /mcp 指令族(spec #246):MCP 服务器管理的编排槽(pi CLI 执行缝 +
   *  登录单飞编排器,组合根经 createMcpOrchestration 装配)。Absence =
   *  /mcp 回复「未启用」,行为与未实现一致。 */
  mcp?: McpOrchestration;
  /** 离线积压结算冻结信号(#136 修法B):装配根在 transport 连接阶段
   *  结束(成功或已处理的失败)后 resolve。缺省 = 已就绪,旧语义。 */
  backlogTransportsReady?: Promise<void>;
  /**
   * 活卡编辑缝(issue #235 票2):由组合根接到发送适配层的编辑方法
   * (Matrix transport 的 editMessage)。与 sendLiveCard **双双注入**聚合
   * 才启用;缺省未注入 = 聚合整体禁用,行为与现状逐字节一致(旧部署、
   * 既有测试零影响)。
   */
  editReply?: (chatId: string, transport: string, messageId: string, text: string) => Promise<void>;
  /**
   * 发一张「活卡」新卡并取回底层 event_id(Matrix 的 sendMessage 穿出值,
   * 票1)——后续中间回合凭它对同一事件就地编辑。返回 undefined(非 Matrix
   * transport、发送失败被吞)= 本回合不进活卡状态,下一中间回合自然重试
   * 开卡。缺省未注入 = 聚合整体禁用(与 editReply 同门)。
   */
  sendLiveCard?: (chatId: string, transport: string, text: string) => Promise<string | undefined>;
  /**
   * 发一条消息并取回底层 event_id 的可选缝(票02 #269:组合根接 Matrix
   * 的 sendMessage 穿出值)。与 sendReaction **双双注入**才启用积压征询的
   * 表情作答;缺省未注入 = 功能禁用,行为与旧版逐字节一致(与 editReply/
   * sendLiveCard 同门)。
   */
  replyWithId?: (chatId: string, transport: string, text: string) => Promise<string | undefined>;
  /**
   * 在一条已发出的消息上种表情的可选缝(票02 #269:组合根接 Matrix 的
   * sendReaction)。与 replyWithId 同门;逐 emoji 失败的降级在 BacklogInbox
   * 内部(只 debug,不影响征询照发)。
   */
  sendReaction?: (chatId: string, eventId: string, emoji: string) => Promise<void>;
  /** /update 热更新编排器(桥自更新 spec §8):组合根构造注入 —— slashCommands
   *  阶段按本消息预绑定 IO(reply 缝、adminRoom、allRpcs、audit)交给它。
   *  依赖面取最小结构(路由侧只调 handleCommand);Absent = /update 回
   *  unavailable 文案(命令层已处理),行为与未接线一致。 */
  updater?: Pick<UpdateOrchestrator, "handleCommand">;
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
  /**
   * reaction 统一入口(票02 #269):provider 的 onReaction 汇入后先做信任
   * 校验(fail-closed,与消息管道 authorizationGate 同一 isTrustedUser 判定
   * ——reaction 不走消息管道,必须自带安检),未授权静默丢弃记日志;通过后
   * 按序尝试各流的 reaction 应答(积压流、extension 流——后者票03 #270)。
   */
  handleReaction(reaction: MatrixReaction): void;
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
  /** Pinned bindings (project rooms) survive completed turns. The shared
   *  default rpc's binding releases on a successful turn; an error turn keeps
   *  it (spec #335) so auto-retry receipts and the recovered final answer
   *  still reach the room that asked, until the next message re-binds it. */
  pinned: boolean;
  replyTarget: ReplyTarget;
}

/** Format a completed turn into reply parts. Returns text = null when the
 *  turn has no narration/error content (the binding is kept for the
 *  follow-up turn); toolsText = null when tool lines are absent or hidden.
 *  Error turns (stopReason "error") always yield replyable text — the failure
 *  line rides along even when the model produced no content (issue #52).
 *  旁白/工具拆分(spec #248):text 只装旁白与错误行,工具行独立出口 ——
 *  聚合路径工具卡只装工具行,旁白独立成卡并断开聚合链;非聚合路径以
 *  fullText 派发,可达路径上与旧整段输出逐字节一致。 */
export function buildTurnReply(
  message: AssistantMessage,
  hideToolCalls?: boolean,
  toolArgLimit?: number
): { text: string | null; toolsText: string | null; fullText: string | null; pendingTools: boolean } {
  const responseText = extractTextFromMessage(message);
  const toolCallsText = formatToolCalls(message, toolArgLimit);
  const pendingTools = hasToolCalls(message);
  const parts: string[] = [];
  const trimmed = responseText.trim();
  if (trimmed) parts.push(trimmed);
  // Error visibility (issue #52): a turn ending with stopReason "error" must
  // reach the room even when the model produced no text — the text=null path
  // used to swallow failed turns silently (holding an unpinned binding
  // forever). Partial content survives; the failure line rides along.
  if (message.stopReason === "error") {
    parts.push(t("router.turn.failed", { message: message.errorMessage ?? t("common.unknownError") }));
  }
  const text = parts.length === 0 ? null : parts.join("\n\n");
  const toolsText = toolCallsText && !hideToolCalls ? toolCallsText : null;
  return {
    text,
    toolsText,
    // 拼装契约的唯一住处(spec #248 评审整改):非聚合派发与 log 预览都吃
    // 这个字段,「空行连接」的口径不再在调用方复写。
    fullText: text === null && toolsText === null ? null : [text, toolsText].filter(Boolean).join("\n\n"),
    pendingTools,
  };
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

/** 保存成功回执(issue #66 票1):路径可见,清单状态不静默。 */
export function attachmentSavedReply(attachment: MessageAttachment): string {
  return t("router.attach.saved", { path: attachment.path, bytes: formatBytes(attachment.bytes) });
}

/** 附件失败回执:transport 给出的原因原样透传(下载/解密/超限各有文案)。 */
function attachmentErrorReply(reason: string): string {
  return `❌ ${reason}`;
}

/** 审计 detail 的单行化契约:空白归一 + 120 截断(上限只在这里出现)。 */

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
      logger.warn(`queue snapshot persist failed (memory mirror stays authoritative): ${errorMessage(err)}`);
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
  // 由调用点裁剪。未注入 = 零审计,行为与现状逐字节一致。主体是三字段
  // 窄形状(#269:reaction 应答没有消息体可取,文字应答传整条消息,结构
  // 兼容),审计只认 谁/哪个通道/哪个房间。
  const auditTrail = (event: string, actor: { userId: string; transport: string; chatId: string }, detail?: string): void => {
    deps.audit?.append(event, namespacedId(actor.userId, actor.transport), actor.chatId, detail);
  };

  // 模型降级链(issue #121):连败记账与耗尽提示的「只提示一次」都在
  // FallbackStreak(model-switch.ts);这里只编排链解析、切换与回执/审计。
  // 项目房用项目链,其余走全局链;链空 = 功能关,行为与旧版逐字节一致。
  const fallbackStreak = new FallbackStreak();
  // 重启失效钩子(#354,评审卡4):进程首见任一键时挂一次 onRestarted 订阅,
  // 触发时广播该 rpc 已登记的全部清理钩子 —— 活卡/工作流卡/降级链各登记
  // 各自的键,「WeakSet 去重」样板(先例注释自我复制)收口于此。
  const restartHooks = new RpcRestartHooks((rpc, handler) => rpc.onRestarted?.(handler));

  const runFallback = async (rpc: PiRpc, origin: { chatId: string; transport: string }): Promise<void> => {
    if (!fallbackStreak.recordFailure(rpc)) return;
    const chain = projectManager.projectFallbacks(origin.chatId) ?? modelFallbackChain(store.get());
    if (chain.length === 0) return;
    let current: { provider?: string; id?: string } | undefined;
    try {
      current = (await rpc.requireClient().getState()).model;
    } catch {
      return; // 进程已不可用,无从切换 —— 失败回执走正常路径呈现
    }
    const from = current?.provider ? `${current.provider}/${current.id}` : "?";
    const next = nextFallbackTarget(chain, current);
    if (!next) {
      if (fallbackStreak.markExhaustedNotified(rpc)) {
        await sendReply(
          origin.chatId,
          origin.transport,
          t("router.fallback.exhausted", { count: MODEL_FALLBACK_THRESHOLD, chain: chain.join(" → ") })
        );
      }
      return;
    }
    const to = `${next.provider}/${next.id}`;
    try {
      await rpc.requireClient().setModel(next.provider, next.id);
    } catch (err) {
      await sendReply(
        origin.chatId,
        origin.transport,
        t("router.fallback.switchFailed", { count: MODEL_FALLBACK_THRESHOLD, to, message: errorMessage(err) })
      );
      return;
    }
    await sendReply(origin.chatId, origin.transport, t("router.fallback.switched", { count: MODEL_FALLBACK_THRESHOLD, from, to }));
    deps.audit?.append(
      AUDIT_EVENTS.modelFallback,
      "system",
      origin.chatId,
      `${from} → ${to} after ${MODEL_FALLBACK_THRESHOLD} consecutive failed turn(s)`
    );
  };

  // 交接卡(issue #122):轮数记账与在途捕获槽都在 RecapLedger(recap.ts);
  // 这里只编排门控(忙拒/空会话)、投递与 /new 联动。
  const recapLedger = new RecapLedger();

  // ── 卡片机件(#354,评审卡2:机件沉到编辑缝下)────────────────────────
  // 工具循环活卡与工作流进度卡的两台状态机整体迁入 card-session.ts:机件
  // 单点(代次捕获/在途写回作废/重启失效,此前复制两份;活卡 bug 曾连续
  // 三条 spec 回炉),策略各自成类(降级直发 vs 放大间隔重试、FIFO 出站链
  // vs fire-and-forget、节流/终态仅工作流有)。router 只剩编排:轮次边界
  // 清卡、段落派发喂卡、快照喂工作流账本。
  const toolCards = new ToolTurnCards({
    ...(deps.editReply !== undefined && deps.sendLiveCard !== undefined
      ? { seam: { editReply: deps.editReply, sendLiveCard: deps.sendLiveCard } }
      : {}),
    sendReply,
    restart: restartHooks,
  });
  const workflowCards = new WorkflowProgressCards({
    ...(deps.editReply !== undefined && deps.sendLiveCard !== undefined
      ? { seam: { editReply: deps.editReply, sendLiveCard: deps.sendLiveCard } }
      : {}),
    isEnabled: () => workflowProgressCard(store.get()) && deps.editReply !== undefined && deps.sendLiveCard !== undefined,
    throttleMs: () => workflowCardThrottleMs(store.get()),
    targetFor: (rpc) => bindings.get(rpc)?.replyTarget,
    labels: workflowCardLabels(),
    degradedRetryMs: WORKFLOW_CARD_DEGRADED_RETRY_MS_DEFAULT,
    restart: restartHooks,
  });

  /** 聚合启用 = 配置开(缺省 true)+ 编辑缝双双注入 + hideToolCalls 关闭。
   *  配置现读现判:运行时改配置(手编 + 重启,或 / 系命令写路径)即时生效。 */
  const liveCardAggregation = (): boolean =>
    aggregateToolTurns(store.get())
    && !store.get().hideToolCalls
    && deps.editReply !== undefined
    && deps.sendLiveCard !== undefined;

  // 票06(spec #299):房间级工具流三态(auto/on/off)解析单点。显式 on/off
  // 覆盖一切 —— 但 "on" 仍需活卡缝齐备且全局 hideToolCalls 未开(全局开关
  // 保留为 kill-switch,评审整改:不再绕过),否则降级 off 防工具行无声丢失。
  // auto:协作房关(本房绑定为 guest,或登记簿已见对端 bot —— 决定11
  // "含客座的协作房=关"对 owner 侧同样成立);owner 单 bot 房跟随全局现状。
  // 活卡与 typing 互补不同时开:工具流开的房活卡表活,关的房 typing 表活
  // (活卡房 turn_start 不再发 typing,系本票有意变化,替代 1.6.x 的无条件首拍)。
  const roomToolCallsMode = (roomId: string): "on" | "off" => {
    // 读侧意图方法(#356):房间设置与 guest 模式都经 ProjectManager 的
    // 意图方法取 —— projectMap 返回形状不再外泄,可选链退役。
    const setting = projectManager.showToolCallsForRoom(roomId);
    if (setting === "off") return "off";
    if (setting === "on") {
      return deps.sendLiveCard !== undefined && deps.editReply !== undefined && !store.get().hideToolCalls
        ? "on"
        : "off";
    }
    const collabRoom = projectManager.isGuestRoom(roomId) || (botRegistry.cached(roomId)?.size ?? 0) > 0;
    return collabRoom ? "off" : liveCardAggregation() ? "on" : "off";
  };



  /** 卡片投递:当前房间必发;多工程下有管理房且不同于本房间时抄送一份
   *  「📋 <项目名> 交接卡」,沉淀为该项目的干活日志时间线。 */
  const deliverRecapCard = async (rpc: PiRpc, body: string, origin: { chatId: string; transport: string }): Promise<void> => {
    let context: string | null = null;
    try {
      context = (await collectStatusFooter(rpc)).context;
    } catch {
      // 上下文行现拉现用,缺就缺(卡片其余部分不受影响)
    }
    const state = await rpc.requireClient().getState().catch(() => undefined);
    const sessionHint = state && typeof state.sessionId === "string" ? state.sessionId : undefined;
    const project = projectManager.labelForRoom(origin.chatId);
    const card = renderRecapCard({
      title: recapCardTitle(sessionHint),
      body,
      project: project ?? undefined,
      context,
    });
    // 卡片按普通回复同款分片:模型超字数(200 字是纪律不是硬约束)时,
    // 超长单条会撞 Matrix 事件大小上限 —— 分片保证卡片一定送达。
    const ccPrefix = project ? `${recapCcPrefix(project)}\n\n` : "";
    for (const chunk of splitMessage(card, 4000)) {
      await sendReply(origin.chatId, origin.transport, chunk);
    }
    const managementRoom = managementRoomId(store.get());
    if (managementRoom && managementRoom !== origin.chatId) {
      const ccBody = `${ccPrefix}${card}`;
      for (const chunk of splitMessage(ccBody, 4000)) {
        await sendReply(managementRoom, origin.transport, chunk);
      }
    }
  };

  /** /recap:忙碌拒绝在先(不与在跑任务争抢 steering 语义),空会话拒绝
   *  其次(轮数不足没得总结),然后才是一次真实模型调用。 */
  const runRecap = async (rpc: PiRpc, origin: { chatId: string; transport: string }): Promise<void> => {
    const state = await rpc.requireClient().getState();
    if (state.isStreaming) throw new RecapBusyError();
    if (recapLedger.count(rpc) < RECAP_MIN_TURNS) throw new RecapEmptyError();
    const body = await recapLedger.startCapture(rpc);
    await deliverRecapCard(rpc, body, origin);
  };

  /** /new //clear 前的自动出卡(recap.onNew 开 + 轮数达标)。任何失败只
   *  warn —— 交接卡是锦上添花,永远不能变成 /new 的单点故障(钉点测试)。 */
  const beforeNewRecap = async (rpc: PiRpc, origin: { chatId: string; transport: string }): Promise<void> => {
    if (!recapOnNew(store.get())) return;
    try {
      const state = await rpc.requireClient().getState();
      if (state.isStreaming) return;
      if (recapLedger.count(rpc) < RECAP_MIN_TURNS) return;
      const body = await recapLedger.startCapture(rpc);
      await deliverRecapCard(rpc, body, origin);
    } catch (err) {
      logger.warn(`recap before /new failed (continuing): ${errorMessage(err)}`);
    }
  };

  // 待处理附件清单(issue #66 票1):按 房间+发送者 记账,2026-10-27 扫描
  // 批次 A 自此出门为 AttachmentLedger(与 BacklogInbox / ExtensionQuestions
  // / RecapLedger 同构)—— TTL、\u0000 键编码、落盘形状都在 module 里,
  // 管道三阶段只调用:media 停车 / prompt 成功消费 / 房间销账清空。消耗
  // 规则不变:该发送者在同一条管道里真正发给 pi 的下一条对话消息一次性
  // 带上全部并清空;管理命令、登录/extension-ui 应答捕获都在注入点之前
  // return,天然不消耗。
  const attachmentLedger = new AttachmentLedger(deps.attachmentsLedger);

  // 在跑 bash 记账(/bashstop 的数据源):/bash 与 `!`/`!!` 共用一份,
  // 按 pi 进程记账,promise 落定自动销账(见 createBashTracker)。
  const bashTracker: BashTracker = createBashTracker();

  // ---- 离线收件箱(issue #113):状态与结算语义在 BacklogInbox module -------
  // transport 只负责判定「这是离线积压」(stale + 台账没见过,带 replayed
  // 标记);缓冲、征询与执行裁决都在模块里。授权门控仍归管道:两个积压阶段
  // 都跑在授权裁决之后,未信任者的积压与应答根本到不了这里。deliver 回调在
  // 调用时才解引用 router(构造期 router 尚未存在,只在调用时求值,无 TDZ)。
  const inbox = new BacklogInbox({
    reply: sendReply,
    // #136 修法B:结算定时器冻结到 transport 连接阶段结束(装配根注入,
    // 连接 try/catch 后 resolve);缺省 = 已就绪(旧语义)。
    transportsReady: deps.backlogTransportsReady,
    // 表情作答缝(票02 #269):组合根只在 Matrix transport 存在时注入,
    // 双双注入才启用;缺省未注入 = 功能禁用,行为与旧版逐字节一致。
    ...(deps.replyWithId && deps.sendReaction
      ? { replyWithId: deps.replyWithId, sendReaction: deps.sendReaction }
      : {}),
    deliver: async (entries) => {
      for (const entry of entries) {
        const { replayed: _strip, ...realtime } = entry;
        await router.handleIncoming(realtime);
      }
    },
    config: () => store.get(),
    onExecute: (actor, count) => auditTrail(AUDIT_EVENTS.backlogExecute, actor, `delivering ${count} offline backlog message(s)`),
  });


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
    // 表情作答缝(票03 #270):与 BacklogInbox 同门同形,双双注入才启用;
    // 缺省未注入 = 功能禁用,提问照走 sendReply,行为与旧版逐字节一致。
    ...(deps.replyWithId && deps.sendReaction
      ? { replyWithId: deps.replyWithId, sendReaction: deps.sendReaction }
      : {}),
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

  // 票02(spec #299):房间 bot 登记簿读缓存 + 陌生房"无管理房"告警簿记。
  const botRegistry = new BotRegistry(roomOps);
  const unknownNoManagementWarned = new Set<string>();
  // 票05(spec #299):房间增量信箱 —— 未触发的可见文本在此攒,触发时并入 prompt。
  const mailbox = new RoomMailbox();
  // 认领簿记域入口(#352):三个落盘簿记的读写纪律(并发重读/上限/身份过滤)
  // 内化在 ClaimLedger,本阶段只调 API。
  const claimLedger = new ClaimLedger(store);
  // 票06(spec #299):工具流关闭房间的 typing 续期节流(5s)与回合停止簿记。
  // sendTyping 缝兼容旧假件(可能不返回 Promise):统一 Promise.resolve 包裹。
  const TYPING_RENEW_INTERVAL_MS = 5_000;
  const lastTypingRenewalAt = new Map<string, number>();
  const sendTypingSafe = (chatId: string, transport: string, active = true): void => {
    void Promise.resolve(sendTyping(chatId, transport, active)).catch(() => {});
  };
  // 票08(spec #299):重启缺口声明簿记 —— 每房每进程生命周期声明一次。
  const bootedAt = new Date();
  const restartGapDeclared = new Set<string>();

  const stages: Array<PipelineStageView & { handle: (ctx: StageContext) => Promise<boolean> }> = [
    {
      name: "botFilter",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // 票02(spec #299):已登记的对端 bot 消息不触发、不进命令解析 ——
      // 防互聊回环的第一道闸(自家消息在 transport 层已滤,botFilter 补上
      // "别人家的 bot")。票05 升级:不再丢弃,改为进房间增量信箱(可见文本
      // 共享 —— 它们的最终回复是上下文的一部分)。
      // 排在授权之前:bot 不是人类用户,不进挑战流,也不该消耗授权副作用。
      handle: async (ctx) => {
        const bots = await botRegistry.botsOf(ctx.msg.chatId);
        if (!bots.has(ctx.msg.userId)) return false;
        // 斜杠命令类文本不进信箱(与 guestTrigger 同规则,票05 评审整改)。
        // 顺序耦合:botFilter 必须先于 guestTrigger —— 否则登记 bot 的消息
        // 会经 guestTrigger 二次入信箱(阶段表测试钉住该顺序)。
        // senderLabel 用 MXID(任务2 审计整改,防 displayname 冒充)。
        if (ctx.msg.payload.kind === "text" && ctx.text && !ctx.text.startsWith("/")) {
          mailbox.pushVisible(ctx.msg.chatId, ctx.msg.userId, ctx.text);
        }
        ctx.log.info(`🤖 对端 bot 消息进增量信箱(不触发): ${ctx.msg.userId} in ${ctx.msg.chatId}`);
        return true;
      },
    },
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
      name: "guestTrigger",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 票05(spec #299):guest 房仅 @提及触发 —— 触发权分开,上下文共享。
      // 票审计整改(任务2):本阶段从积压后**前移到 authorization 之后** ——
      // 群聊频道未 enable 时 authorizationGate 会把未授权消息整条截停,
      // guest 房的未点名文本永远到不了信箱(真机 lab 复现)。现在的口径:
      //   @点名        → 照常走管线(授权门裁决,门后 prompt)
      //   房间级命令   → 受信者放行本端解析(各端各自执行,票07 模式)
      //   受信未点名   → 增量信箱(可见文本共享;斜杠不进信箱)—— 频道模式
      //                  只裁"触发",不裁被动共享,故按 isTrustedUser 判定
      //   未受信       → 静默吞(陌生人不可投毒信箱,spec 授权模型优先)
      // owner 房与单项目模式不走本阶段,行为与 1.6.x 一致。
      handle: async (ctx) => {
        if (!ctx.multiProject || !ctx.msg.isGroupChat) return false;
        if (projectManager.modeForRoom(ctx.msg.chatId) !== "guest") return false;
        if (ctx.msg.wasMentioned === true) return false;
        if (!auth.isTrustedUser(ctx.msg.userId, ctx.msg.transport)) return true; // 未受信静默
        if (ctx.msg.payload.kind === "text" && ctx.text && /^\/compact(\s|$)/i.test(ctx.text)) {
          return false; // 房间级命令:受信者放行本端执行
        }
        if (ctx.msg.payload.kind === "text" && ctx.text && !ctx.text.startsWith("/")) {
          mailbox.pushVisible(ctx.msg.chatId, ctx.msg.userId, ctx.text);
        }
        return true;
      },
    },
    {
      name: "unknownRoomGate",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // 票02(spec #299):多项目模式下,未映射的群聊房间一律不路由、绝不
      // 落默认项目 —— 安全默认(Q13 决议:陌生房接活是事故源)。进房后向
      // 本部署管理房发一次认领提示(落盘簿记,同房不重复刷);管理房缺位
      // 则 warn 一次(进程内存簿记,提示送达前不标记)。排在附件之前:
      // 陌生房连附件清单都不该进。collab.allowUnknownRoomFallback=true
      // 恢复 1.6.x 旧行为(回落默认项目)。
      handle: async (ctx) => {
        const { msg } = ctx;
        if (!ctx.multiProject || !msg.isGroupChat) return false;
        if (projectManager.isProjectRoom(msg.chatId)) return false;
        const config = store.get();
        if (config.collab?.allowUnknownRoomFallback === true) return false;
        if (managementRoomId(config) === msg.chatId) return false;
        // 票04:带项目元数据(含仓库地址)→ 发认领确认卡并落簿待认领;
        // 无元数据 → 普通提示(每房一次)。任务3 场景测试修复:两簿记分离 ——
        // 普通提示过的房在 URL 后补(mv 重探)后仍可升级发卡,后补通道不再死锁;
        // 认领卡自己的去重 = pendingClaims 挂单存在,或该房同 URL 已被拒绝
        // (claimRejectedKeys;簿记读写已内化在 ClaimLedger,#352)。
        const mgRoom = managementRoomId(store.get());
        if (!mgRoom) {
          // 管理房缺位:提示无处送达 —— 每房 warn 一次(内存簿记,不标记落盘,
          // 提示送达前不算数)。
          if (!unknownNoManagementWarned.has(msg.chatId)) {
            unknownNoManagementWarned.add(msg.chatId);
            logger.warn(`🚪 陌生房 ${msg.chatId} 不接活,但本部署尚无管理房,认领提示无法送达`);
          }
          return true;
        }
        const meta = (await roomOps?.getProjectMeta?.(msg.chatId)) ?? null;
        if (
          meta?.gitUrl &&
          !claimLedger.hasPendingClaim(msg.chatId) &&
          !claimLedger.isRejectedFor(msg.chatId, meta.gitUrl)
        ) {
          // 目录展示与 /pmctl claim 的落地口径同源(effectiveWorkdir =
          // resolveProjectPath 的根;评审整改:不再 workdir??"~" 手拼)。
          const dir = path.join(effectiveWorkdir(store.get()), repoNameFromUrl(meta.gitUrl));
          const index = claimLedger.claims().length + 1;
          await sendReply(
            mgRoom,
            msg.transport,
            t("collab.claim.card", { room: msg.chatId, name: meta.name, url: meta.gitUrl, dir, index })
          );
          // 落盘前重读与上限收敛内化在 ledger(#352):sendReply 是 await 点,
          // handleIncoming 可并发。
          claimLedger.recordClaimCard(msg.chatId, meta.gitUrl, meta.name);
          ctx.log.info(`🚪 陌生房 ${msg.chatId} 带项目元数据,已向管理房发认领卡(#${index})`);
        } else if (!claimLedger.hasNoticed(msg.chatId) && !claimLedger.hasPendingClaim(msg.chatId)) {
          await sendReply(mgRoom, msg.transport, t("router.unknownRoom.notice", { room: msg.chatId }));
          claimLedger.recordNotice(msg.chatId);
          ctx.log.info(`🚪 陌生房 ${msg.chatId} 不接活,已向管理房发认领提示`);
        }
        return true;
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
            attachmentLedger.park(ctx.msg.chatId, ctx.msg.userId, ctx.msg.payload.saved);
            for (const attachment of ctx.msg.payload.saved) {
              await sendReply(ctx.msg.chatId, ctx.msg.transport, attachmentSavedReply(attachment));
            }
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
            // organizational space — fire-once, best-effort (see space-topology.ts).
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
        if (!msg.isGroupChat || !/^\/enable(\s|$)/i.test(text)) return false;
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
      name: "roomToolsToggle",
      preAuth: true,
      consumesLedger: false,
      needsRpc: false,
      // 票06(spec #299):项目房内 /toggletools <auto|on|off> —— 房间级
      // 工具流覆盖(缺省 auto=owner 开/guest 关)。管理房与 DM 的全局开关
      // 走既有 adminCommands 路径;本阶段只认多项目下的项目房,admin 门内判。
      handle: async (ctx) => {
        const { msg, text } = ctx;
        if (!/^\/toggletools(\s|$)/i.test(text)) return false;
        if (!ctx.multiProject || !msg.isGroupChat || !projectManager.isProjectRoom(msg.chatId)) return false;
        if (!auth.isAdminUser(msg.userId, msg.transport)) {
          await sendReply(msg.chatId, msg.transport, t("pmctl.adminOnly"));
          return true;
        }
        const arg = text.split(/\s+/)[1]?.toLowerCase() ?? "";
        if (arg !== "auto" && arg !== "on" && arg !== "off") {
          await sendReply(msg.chatId, msg.transport, t("collab.tools.usage"));
          return true;
        }
        projectManager.setRoomShowToolCalls(msg.chatId, arg);
        await sendReply(msg.chatId, msg.transport, t("collab.tools.ok", { mode: arg }));
        return true;
      },
    },
    {
      name: "authorizationGate",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Unauthorized senders stop here, silently — same treatment as text.
      // 访客档(issue #120):名单内的人放行进管道,但禁用清单上的命令在此
      // 硬拦 —— 回执礼貌说明 + 审计留痕(#124 的 guest.denied 事件)。
      // 权限边界在桥,不靠模型自觉;房间模式(trusted-only 等)语义优先,
      // 已在上面裁决,访客在 trusted-only 群里照旧门外。
      handle: async (ctx) => {
        if (!ctx.isAuthorized) return true;
        if (auth.isGuestUser(ctx.msg.userId, ctx.msg.transport)) {
          const verdict = guestCommandVerdict(ctx.text);
          if (verdict.blocked) {
            await sendReply(ctx.msg.chatId, ctx.msg.transport, t("guest.denied", { command: verdict.command }));
            auditTrail(AUDIT_EVENTS.guestDenied, ctx.msg, `blocked command: ${verdict.command}`);
            return true;
          }
        }
        return false;
      },
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
        return inbox.answer(ctx.text, ctx.msg);
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
      handle: async (ctx) => inbox.accept(ctx.msg),
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
        if (!/^\/multiproject(\s|$)/i.test(text)) return false;
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
      // 处理器住址(#358):审计+门禁+分派在 command-dispatch,阶段壳只编排。
      handle: async (ctx) =>
        await handlePmctlFamily(
          { pmctl, auth, audit: auditTrail, reply: sendReply },
          { text: ctx.text, msg: ctx.msg, isManagementRoom: ctx.isManagementRoom },
        ),
    },
    {
      name: "login",
      preAuth: false,
      consumesLedger: false,
      needsRpc: false,
      // Headless login (issue #55): /login /logout /auth — admin + management
      // room only. Single-project mode has no management room: a DM counts as
      // one (that is where the admin talks to the bot there).
      // 处理器住址(#358):审计+门禁+三命令分派在 command-dispatch。
      handle: async (ctx) =>
        await handleLoginFamily(
          { auth, login, audit: auditTrail, reply: sendReply },
          {
            text: ctx.text,
            msg: ctx.msg,
            multiProject: ctx.multiProject,
            isManagementRoom: ctx.isManagementRoom,
          },
        ),
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
            // bash 回帖截断上限(config bashOutputLimit;`!`/`!!` 与 /bash 共用一份派生值)
            bashOutputLimit: bashOutputLimit(store.get()),
            // /update 热更新(桥自更新 spec §4):adminRoom 按 login 的既定口径
            // 计算 —— 多工程看管理房收养结果;单工程没有管理房,DM 即管理房。
            // 不传 ctx.isManagementRoom:单工程下它恒 false(multiProject 可选
            // 默认 false),照传会让 /update 成为死路。
            adminRoom: ctx.multiProject ? ctx.isManagementRoom : !ctx.msg.isGroupChat,
            // 编排器插槽:组合根注入的 UpdateOrchestrator,状态机的同步段固定
            // 顺序(§5.3)在其 handleCommand 内。Absent = /update 回 unavailable。
            updater: deps.updater ? { handle: (args, io) => deps.updater!.handleCommand(args, io) } : undefined,
            // 审计缝(issue #124):命令层只报「发生了什么」,落账仍在 router
            //(/stop //interrupt 的真实清队、/bash 的 shell 执行由此上报)。
            audit: (event, detail) => auditTrail(event, ctx.msg, detail),
            // 交接卡(issue #122):/recap 与 /new 联动,均绑定本消息的房间
            // 与进程;卡片投递(含管理房抄送)在 deliverRecapCard 内。
            recap: {
              run: () => runRecap(rpc, { chatId: ctx.msg.chatId, transport: ctx.msg.transport }),
              beforeNew: () => beforeNewRecap(rpc, { chatId: ctx.msg.chatId, transport: ctx.msg.transport }),
              onSwitched: () => recapLedger.reset(rpc),
            },
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
            // /mcp 指令族(spec #246):编排槽 + adminRoom 守卫按本消息预绑定
            // (命令层不接触 chatId/userId)。口径与 /login 族一致:管理员,
            // 且多工程限管理房间 / 单工程限私聊 —— 配 MCP = 给 agent 加工具
            // 与外发通道,授权面从紧。
            mcp: deps.mcp
              ? {
                  ...deps.mcp,
                  adminAllowed:
                    auth.isAdminUser(ctx.msg.userId, ctx.msg.transport) &&
                    (ctx.multiProject ? ctx.isManagementRoom : !ctx.msg.isGroupChat),
                }
              : undefined,
          });
          // 审计(issue #124):命令面按登记表落账 —— 只记敏感动作
          //(登记表 auditEvent 位;清队走上面的 audit 缝,由命令层按真实
          // 语义上报)。handled=false 的未识别斜杠不记。
          if (handled) {
            const cmdName = ctx.text.trim().split(/\s+/)[0]!.toLowerCase();
            const auditEvent = commandPolicy(cmdName)?.auditEvent;
            if (auditEvent) auditTrail(auditEvent, ctx.msg, normalizeDetailLine(ctx.text));
          }
          return handled;
        } catch (err) {
          // 命令名进日志(F5 顺手):「谁遭殃」一眼可查 —— 例:登录成功触发的
          // 自动重启连带击杀在途命令时,❌ 回执只有笼统文案,日志必须能对上。
          logger.error(
            `❌ 命令执行失败 [${ctx.text.trim().split(/\s+/)[0] ?? "?"}]: ${errorMessage(err)}`,
          );
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("cmd.generic.error", { message: errorMessage(err) }));
          return true;
        }
      },
    },
    {
      name: "bashBang",
      preAuth: false,
      consumesLedger: false,
      needsRpc: true,
      // `!`/`!!` bash 快捷执行(≈ pi TUI 的 !/!!):收到即回执,执行期间把上游
      // bash_execution_update 增量流式编辑进同一张活卡(spec #193,节流对齐
      // 活卡 skip 模式),终态就地变形为最终回帖(替代「完成才回帖」的第二条
      // 消息);变形失败降级新消息,结果永不丢。活卡缝未注入(非 Matrix)→
      // 现状逐字节的两条消息路径。不等待完成 —— 长命令不阻塞管道,后续消息
      // 照常处理;记账进 bashTracker 供 /bashstop 列出/中止。
      handle: async (ctx) => {
        const bang = parseBangCommand(ctx.text);
        if (!bang) return false;
        const rpc = await ctx.roomRpc();
        // 审计(issue #124):shell 快捷执行是危险面的正门,进出都留痕。
        auditTrail(AUDIT_EVENTS.bashExec, ctx.msg, `${bang.excluded ? "!!" : "!"} ${bang.command}`);
        const release = bashTracker.track(rpc, bang.command);
        const { chatId, transport } = ctx.msg;
        const inProgressText = t("router.bang.inProgress", {
          command: bang.command,
          suffix: bang.excluded ? t("cmd.bash.excludedNote") : "",
        });
        const limit = bashOutputLimit(store.get());
        const throttleMs = workflowCardThrottleMs(store.get());
        // 流式活卡状态(spec #193):sendLiveCard + editReply 双注入才启用。
        // 卡发送不等待(不阻塞管道)——命令先发;卡迟到/失败与终态竞速由
        // settledText 收口:卡先到先流式,终态先到则卡落地后直接变形,
        // 卡彻底失败退回新消息路径。任何顺序下结果都不丢、卡不停在中间帧。
        const live = Boolean(deps.sendLiveCard && deps.editReply);
        let cardId: string | undefined;
        let cardPending = live;
        let buffer = "";
        let lastEditAt = 0;
        let settledText: string | undefined;
        const pushPreview = () => {
          if (!cardId || settledText) return;
          if (Date.now() - lastEditAt < throttleMs) return;
          lastEditAt = Date.now();
          void deps.editReply!(chatId, transport, cardId, formatBashPreview(bang.command, buffer, bang.excluded, limit)).catch(() => {});
        };
        const settleNow = () => {
          const text = settledText;
          if (!text) return;
          if (cardId) {
            // 终态变形失败 → 新消息兜底(结果永不丢);再失败则放弃。
            deps.editReply!(chatId, transport, cardId, text)
              .catch(() => sendReply(chatId, transport, text))
              .catch(() => {});
          } else if (!cardPending) {
            void sendReply(chatId, transport, text).catch(() => {});
          }
          // cardPending:卡还在路上,落地分支(settleIfLate)收口。
        };
        if (live) {
          deps
            .sendLiveCard!(chatId, transport, inProgressText)
            .then((id) => {
              cardId = id || undefined;
              cardPending = false;
              if (settledText) {
                settleNow();
                return;
              }
              if (cardId) {
                // 卡落地前已有增量在缓冲 → 立即补一帧;空缓冲不发空帧(省一次编辑)。
                if (buffer) pushPreview();
              } else void sendReply(chatId, transport, inProgressText).catch(() => {});
            })
            .catch(() => {
              cardPending = false;
              if (!settledText) void sendReply(chatId, transport, inProgressText).catch(() => {});
            });
        } else {
          void sendReply(chatId, transport, inProgressText).catch(() => {});
        }
        rpc.bash(bang.command, {
          excludeFromContext: bang.excluded,
          onUpdate: live
            ? (delta: string) => {
                buffer += delta;
                pushPreview();
              }
            : undefined,
        })
          .then((result) => {
            settledText = formatBashReply(bang.command, result, bang.excluded, bashOutputLimit(store.get()));
            settleNow();
          })
          .catch((err: unknown) => {
            // 超时弃权(票 #220)出人话(含已等待时长);其余照旧透传。
            settledText = bashTimeoutText(err) ?? t("cmd.bash.error", { message: errorMessage(err) });
            settleNow();
          })
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
      // 身份关在 deliver 内(sec-login-sender-guard):非发起者的消息原样
      // 落穿,isPending 仅作快速预检、不做身份裁决。
      handle: async (ctx) => {
        if (ctx.text.startsWith("/")) return false;
        return (
          login.isPending(ctx.msg.chatId) &&
          (await login.deliver(ctx.msg.chatId, ctx.msg.userId, ctx.text))
        );
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
        // 票05(spec #299):触发点清仓增量信箱 —— 未触发的房间可见文本以摘要
        // 并入本次 prompt;信箱空 = 原文逐字节(单 bot 房零变化)。drain 无失败
        // 路径,置于 try 之外;prompt 失败在 catch 里 refund(失败不消耗)。
        const mail = mailbox.drain(ctx.msg.chatId);
        // 票08(spec #299):诚实声明 —— guest 房本进程首次触发注明重启缺口
        // (重启期间的房间消息可能未进信箱;不编造条数,不装知道)。每房一次。
        let gapNote = "";
        if (
          !restartGapDeclared.has(ctx.msg.chatId) &&
          ctx.multiProject &&
          projectManager.modeForRoom(ctx.msg.chatId) === "guest"
        ) {
          gapNote = `${t("collab.mailbox.restartGap", { at: bootedAt.toLocaleString() })}\n`;
        }
        try {
          // 两段式消费(AttachmentLedger 契约):peek 不动账,prompt 成功才
          // release —— 失败不消耗,重试仍带上(消费即清空是成功语义)。
          const pending = attachmentLedger.peek(ctx.msg.chatId, ctx.msg.userId);
          const quoted = ctx.msg.payload.kind === "text" ? ctx.msg.payload.quoted : undefined;
          // 来源标注(issue #124):附件与引用进 prompt 时带「谁发的」——
          // 第三方内容以数据身份入上下文,不冒充指令。
          const basePrompt = withAttachmentPrefix(withQuotePrefix(ctx.text, quoted), pending, {
            user: ctx.msg.userId,
            room: ctx.msg.chatId,
          });
          const promptText =
            mail.lines.length > 0
              ? t("collab.mailbox.digest", {
                  count: mail.lines.length,
                  droppedSuffix:
                    mail.dropped > 0 ? t("collab.mailbox.droppedSuffix", { count: mail.dropped }) : "",
                  lines: mail.lines.join("\n"),
                  text: basePrompt,
                })
              : basePrompt;
          await rpc.prompt(gapNote + promptText);
          // 声明在 prompt 成功后烧掉(评审整改):首次触发失败(refund)时,
          // 下次触发仍会补声明 —— 不因一次失败永久哑火。
          if (gapNote) restartGapDeclared.add(ctx.msg.chatId);
          attachmentLedger.release(ctx.msg.chatId, ctx.msg.userId);
        } catch (err) {
          // rpc 已在此前 roomRpc() 解析,本段不可能产生 RPC_ABORT(审计工程批 票20)。
          // 信箱退款(票05 评审整改):失败不消耗,重试仍带上 —— 与附件同款语义。
          mailbox.refund(ctx.msg.chatId, mail);
          await sendReply(ctx.msg.chatId, ctx.msg.transport, t("router.prompt.failed", { message: errorMessage(err) }));
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
     *  落盘,返回条数。语义归 AttachmentLedger.purgeRoom(房间删除后其
     *  清单条目已无人能消费 —— 意图随房间销账,不等 24h TTL 自然过期)。 */
    purgeRoomAttachments(roomId: string): number {
      return attachmentLedger.purgeRoom(roomId);
    },

    /** reaction 统一入口(票02 #269;票03 #270 接入 extension 流)。先信任
     *  校验 fail-closed:reaction 不走消息管道(authorizationGate 拦不到它),
     *  必须自带安检 —— 与消息管道同一 isTrustedUser 判定;未授权静默丢弃,
     *  记一条 info。reaction 只会来自 Matrix transport(票01 的 onReaction
     *  是 Matrix provider 的缝),transport 口径恒为 "matrix"。通过后按序
     *  尝试积压流、extension 流;谁都没认领(无主/超时/未知 key)按噪音
     *  策略静默,仅 debug 一条。 */
    handleReaction(reaction: MatrixReaction): void {
      if (!auth.isTrustedUser(reaction.sender, "matrix")) {
        logger.info(`[reaction] unauthorized sender ignored: ${reaction.sender} in ${reaction.chatId}`);
        return;
      }
      if (inbox.answerByReaction(reaction.chatId, reaction.targetEventId, reaction.key, reaction.sender)) return;
      // extension 流(票03 #270):需要该房间绑定的 pi 进程(extensionCapture
      // 的 roomRpc 同源;不 bind —— reaction 不是消息,不挪回复绑定)。起不了
      // 进程 = 无处作答,按静默处理(噪音策略,无回执通道)。
      void Promise.resolve(projectManager.getRpcForRoom(reaction.chatId))
        .then((rpc) => {
          if (questions.deliverReaction(rpc, reaction.chatId, reaction.targetEventId, reaction.key)) return;
          logger.debug(`[reaction] no pending prompt claims ${reaction.targetEventId} (key=${reaction.key})`);
        })
        .catch((err: unknown) => {
          logger.debug(`[reaction] rpc unavailable, extension reaction dropped in ${reaction.chatId}: ${errorMessage(err)}`);
        });
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
            void sendReply(msg.chatId, msg.transport, t("router.rpc.startFailed", { message: errorMessage(err) }));
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

      // 降级链重启归零(spec #335):/reload 或崩溃拉起会复用同一个 PiRpc
      // 实例(被杀进程不会补发 auto_retry_end),重试标记若不清会让该进程
      // 的降级链永久静默。键控 once(#354):同 rpc 只登记一次,子进程回来
      // 即 clear() 把重试标记与连败一并归零。
      restartHooks.once(rpc, "fallback-streak", () => fallbackStreak.clear(rpc));

      // 票06(spec #299):工具流关闭的房间,回合期间以原生 typing 续期表活
      // (5s 节流;turn_start 已发首拍);turn_end 主动停,不等 10s TTL 尾巴。
      if (target && event.type !== "turn_start") {
        if (event.type === "turn_end") {
          if (lastTypingRenewalAt.delete(target.chatId)) {
            sendTypingSafe(target.chatId, target.transport, false);
          }
        } else if (roomToolCallsMode(target.chatId) === "off") {
          const last = lastTypingRenewalAt.get(target.chatId) ?? 0;
          if (Date.now() - last >= TYPING_RENEW_INTERVAL_MS) {
            lastTypingRenewalAt.set(target.chatId, Date.now());
            sendTypingSafe(target.chatId, target.transport);
          }
        }
      }

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

      // 轮次边界(issue #235 票2):新一轮对话永远开新卡 —— 清活卡与降级
      // 标志,杜绝跨对话误追加旧卡;代次随之递增(spec #242),作废在途
      // 步骤的迟到写回。重启失效另由 onRestarted 订阅兜底。
      if (event.type === "agent_start") {
        toolCards.clear(rpc);
        return;
      }

      if (event.type === "turn_start") {
        if (target) {
          // 票06(spec #299):活卡与 typing 互补不同时开 —— 工具流开的房
          // 活卡表活(不加 typing,与 1.6.x 一致);关的房 typing 表活。
          if (roomToolCallsMode(target.chatId) === "off") {
            sendTypingSafe(target.chatId, target.transport);
            lastTypingRenewalAt.set(target.chatId, Date.now());
          } else {
            lastTypingRenewalAt.delete(target.chatId);
          }
        }
        return;
      }

      if (event.type === "turn_end") {
        recapLedger.increment(rpc);
        if (!target) {
          log.debug(`[agent] turn_end dropped: no replyTarget bound (rpc=${rpc.label ?? "default"})`);
          return;
        }
        // 连败计数(issue #121):彻底失败的轮喂计数,其余轮次清零(工具
        // 循环的中间轮也算成功 —— 模型还在干活,故障 streak 不该跨过它)。
        // 自动切换的回执与失败回复同房间送达;交接卡捕获轮同样计数。
        const turnMessage = event.message as AssistantMessage | undefined;
        const isErrorTurn = turnMessage?.stopReason === "error";
        if (isErrorTurn) {
          void runFallback(rpc, target);
        } else {
          fallbackStreak.clear(rpc);
        }
        const turn = buildTurnReply(
          turnMessage as AssistantMessage,
          store.get().hideToolCalls,
          toolCallArgLimit(store.get())
        );

        // 交接卡捕获(issue #122):在途捕获命中本进程时,终答落卡 —— 工具
        // 循环的中间轮继续等;卡片投递替代原生回复,总结文本不重复发房间。
        const settleVerdict = recapLedger.settleCapture(rpc, turn);
        if (settleVerdict !== "none") {
          log.debug(`[agent] turn_end captured by recap: ${settleVerdict}`);
          // 终答被捕获 = 工具循环结束(issue #235 票2):一并清活卡;中间轮
          // 捕获("wait")不动活卡 —— 工具循环还在继续。
          if (settleVerdict === "settled") toolCards.clear(rpc);
          return;
        }

        // 完整口径(旁白+空行+工具行)由 buildTurnReply.fullText 单一供给
        // (spec #248 评审整改):log 预览与非聚合派发共用,不再复写拼装。
        const replyPreview = turn.fullText ?? "";
        log.info(`[agent] reply to @${target.username}: ${replyPreview.slice(0, 500)}${replyPreview.length > 500 ? "…" : ""}`);

        if (turn.fullText === null) {
          // No content this turn — keep the binding for a follow-up turn
          return;
        }

        // 活卡聚合(issue #235 票2;内容契约修订 spec #248):聚合启用的
        // 中间回合交给出站链决策。旁白断链(spec #248):回合带旁白文本时,
        // 在出站链的单一步骤内 —— 先清活卡(旧卡定稿于既有累积,不再被
        // 编辑)→ 旁白独立直发(普通消息卡,可分片)→ 工具段落交活卡决策。
        // 拆卡口径(spec #297):工具行按段消费 —— 大段参数(原始值含换行)
        // 的调用是拆卡点,独立段先清活卡再单行直发(不进活卡状态、永不被
        // 后续编辑);普通段照旧无卡开卡/有卡追加。段序即调用序,时间线
        // 必为「旧卡 →(旁白)→ 独立卡 → 新卡」:普通回复/开卡/编辑在
        // Matrix transport 走同一条 per-room FIFO,且本步骤与前序步骤经
        // 出站链串行,顺序由架构保证而非时序运气。
        // 报错回合绕过聚合:失败行醒目直达,不埋进持续刷新的卡。
        // hideToolCalls、配置关、编辑缝未注入都落到下方现行派发路径。
        if (turn.pendingTools && roomToolCallsMode(target.chatId) === "on" && !isErrorTurn) {
          const narration: string | null = turn.text;
          const segments = partitionToolCalls(
            turnMessage as AssistantMessage,
            toolCallArgLimit(store.get())
          );
          toolCards.enqueue(rpc, async () => {
            if (narration) {
              // 清卡单一入口含代次递增(spec #242):降级标志随状态一并清除
              // —— 降级绑定旧卡 event_id 上的编辑失败,断链后的新卡自然重试。
              toolCards.clear(rpc);
              for (const chunk of splitMessage(narration, 4000)) {
                await sendReply(target.chatId, target.transport, chunk).catch(() => {});
              }
            }
            // 降级序列整回合直发(spec #297 评审整改):「每回合一条」覆盖
            // 混合段回合 —— 段落级结算只在非降级态进行,降级不因独立段中途
            // 解除(解除只归旁白断链与轮次边界,与旧路径同口径)。
            if (toolCards.isDegraded(rpc)) {
              const toolsText: string = turn.toolsText!; // pendingTools+未隐藏 ⇒ 非空
              for (const chunk of splitMessage(toolsText, 4000)) {
                await sendReply(target.chatId, target.transport, chunk).catch(() => {});
              }
              return;
            }
            for (const segment of segments) {
              if (!segment.standalone) {
                await toolCards.turn(rpc, target, segment.text);
                continue;
              }
              toolCards.clear(rpc);
              for (const chunk of splitMessage(segment.text, 4000)) {
                await sendReply(target.chatId, target.transport, chunk).catch(() => {});
              }
            }
          });
          return;
        }

        const chunks = splitMessage(turn.fullText, 4000);
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

        // 终答回合收敛(issue #235 票2):活卡随之清空 —— 终答永远不进活卡,
        // 下一次工具循环开新卡。同步原位结算,与绑定释放同款不等派发;
        // 清卡单一入口含代次递增,作废在途步骤的迟到写回(spec #242)。
        toolCards.clear(rpc);

        // A successful conversational turn releases unpinned bindings (the
        // shared default rpc) so late events never reply to a stale chat.
        // Pinned project bindings survive (parity with the old roomId path).
        //
        // 错误轮不释放(spec #335):pi 的 auto_retry_start 在错误 turn_end
        // 之后才到(上游时序),桥无法先验判断本轮会不会重试;释放会让
        // 重试进度、「重试耗尽」回执与恢复后的终答全部静默丢掉。错误轮
        // 之后不会再有属于旧聊天的新事件,绑定保留到下一条用户消息重新
        // 绑定(终态错误同理 —— 耗尽回执本来就该回原房间)。
        //
        // 例外(2026-10-11 真机):steering/followUp 队列非空时不释放 —— 被
        // 折叠进运行中任务的消息,其回复在后续 turn 才到;中间任何一次 turn
        // 完成(原任务收尾、自动重试轮)都会把绑定删掉,那些回复就成了
        // "no replyTarget" 系统性丢失(运行中插话、离线积压回放第二条皆
        // 中招,4/4 复现)。队列见空才释放:迟事件保护依旧成立 —— 已收敛
        // 且无排队时,不会再有属于旧聊天的事件。
        const binding = bindings.get(rpc);
        if (!turn.pendingTools && !isErrorTurn && binding && !binding.pinned) {
          const mirror = transient.mirror(rpc);
          const queued = (mirror?.steering.length ?? 0) + (mirror?.followUp.length ?? 0);
          if (queued === 0) bindings.delete(rpc);
        }
        return;
      }

      // Error visibility (issue #52): auto-retry progress reaches the room so
      // a failing round is never silent. Same guard as turn_start's typing:
      // only with a live binding (logAgentEvent above already logs both).
      // 工作流进度活卡(工作流状态机票3):entry_appended 里的进度快照聚合
      // 进一张就地刷新的卡;非进度条目在 adapter 判别后维持现状 debug 日志,
      // 行为逐字节不变。与上方工具循环活卡完全并列、互不触碰。
      if (event.type === "entry_appended") {
        // wire 形状(真机实测):{"type":"entry_appended","entry":{type:"custom",
        // customType,data,...}} —— adapter 消费的是 entry 本体。畸形缺 entry
        // 时原样传入,adapter 判 undefined,落 debug 日志旁路。
        const entry = (rawEvent as { entry?: unknown }).entry;
        workflowCards.handle(rpc, entry ?? rawEvent);
        return;
      }

      if (event.type === "auto_retry_start") {
        // 重试状态属于进程而非房间(spec #335):标记无条件生效,即使此刻
        // 没有绑定(回执仍按原语义只在有 target 时发)。
        fallbackStreak.beginRetry(rpc);
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
        // 只清重试标记,连败 runs 保留(跨提示词的连败要继续累计)。
        fallbackStreak.endRetry(rpc);
        if (event.success !== true && target) {
          sendReply(
            target.chatId,
            target.transport,
            t("router.retry.exhausted", { error: summarizeArg(event.finalError, 300) || t("common.unknownError") })
          ).catch(() => {});
        }
        return;
      }

      // 一次 run 结束(含 prompt/continue 抛异常逃出时 finally 的
      // agent_settled)是重试标记的兜底失效点(spec #335):只清标记,
      // 不清 runs —— 否则跨提示词的连败永远凑不到阈值。
      if (event.type === "agent_settled") {
        fallbackStreak.endRetry(rpc);
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
    return truncateLine(arg, max);
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
