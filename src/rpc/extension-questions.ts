/**
 * Extension-UI 提问机(issue #54,spec #51 票3 落地;spec #99 票3 /
 * issue #104 独立成模块)。
 *
 * Extensions ask the user questions over RPC (confirm/select/input/editor).
 * The courier posts the question to the bound room; the user's next plain
 * message IS the answer. A courier-side timeout answers `cancelled` when
 * nobody is around. Fire-and-forget requests are presented by level (notify)
 * or ignored (TUI-only display methods). 票03 (#270): confirm/select 提问
 * 消息上预种表情(reaction),点击经 router 的 handleReaction → deliverReaction
 * 走同一应答状态机;文字通道原样保留。
 *
 * 模块形状对照 LoginManager(src/auth/headless-login.ts):副作用出口全部
 * 构造时注入(发帖 sendReply、extension_ui 应答写入口 respond、超时时长
 * timeoutMs、重启生命周期订阅 subscribeRestart),模块自己持有每进程 FIFO
 * 队列与超时计时器;router 只编排 —— 收到提问(handle)、收到房间消息尝试
 * 作答(deliver)、进程重启作废(clear)。
 *
 * 不变量(即 interface 契约):
 *   • FIFO 最老优先 —— 只有队列最老的提问收答案;
 *   • invalid 重问不出队 —— 提问保持悬置等下一条消息;
 *   • 消息房间必须与提问房间一致,否则不消费(交还管道);
 *   • 无绑定房间代答取消(一个没人回答的对话框会挂死扩展);
 *   • 超时代答取消并通知房间;已被回答/取消的提问超时无操作;
 *   • 进程重启队列作废 —— 新子进程对旧提问一无所知。
 *
 * Upstream field mapping verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:
 * select/input/editor read `value`, confirm reads `confirmed`, and a
 * cancelled:true response resolves the dialog to its default value.
 */

import { errorMessage } from "../errors.js";
import { truncateLine } from "../formatting.js";
import { t } from "../i18n/index.js";
import { isCancelInput } from "../i18n/parse.js";
import type { LeveledLogger } from "../logger.js";
import { logger } from "../logger.js";
import type { ExternalMessage, MsgBridgeConfig, ReplyTarget } from "../types.js";
import type { ExtensionUIResponsePayload, PiRpc } from "./pi-rpc.js";
import { digitKeycap, parseReactionKey, REACTION_APPROVE, REACTION_REJECT } from "./reactions.js";

/** Runtime view of the upstream RpcExtensionUIRequest — widened like
 *  AgentEventView because the fire-and-forget methods share the wire type. */
export type ExtensionUIRequestView = {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
  notifyType?: string;
};

/** Fallback timeout for pending extension UI questions: the config value is
 *  in minutes, default 10 (issue #54). Read at enqueue time. Upstream's own
 *  shorter select/confirm/input timeouts don't conflict — whichever fires
 *  first wins, and late responses are dropped by id upstream. For editor
 *  (no upstream timeout) this is the only guarantee. */
export function extensionUiTimeoutMs(config: MsgBridgeConfig): number {
  return (config.extensionUiTimeoutMinutes ?? 10) * 60_000;
}

/** The question message posted to the room (issue #54). The phrasing doubles
 *  as the user-facing protocol: reply content is the answer, the cancel word
 *  backs out (both 取消 and cancel accepted — i18n/parse). 票03 (#270): confirm
 *  / select(≤10 项)各补一行表情提示 —— select >10 时换「选项过多」行,不提
 *  表情(那些题上没有表情可点,提示了反而误导)。 */
export function extensionUIQuestionText(request: ExtensionUIRequestView): string {
  const title = truncateLine(request.title ?? t("xq.untitled"), 200);
  switch (request.method) {
    case "confirm":
      return `❓ ${title}\n${truncateLine(request.message ?? "", 300)}\n${t("xq.confirm.how")}`;
    case "select": {
      const lines = (request.options ?? []).map((option, i) => `${i + 1}. ${option}`);
      const how = (request.options?.length ?? 0) > 10 ? t("xq.select.howMany") : t("xq.select.how");
      return `❓ ${title}\n${lines.join("\n")}\n${how}`;
    }
    default: // input / editor
      return `❓ ${title}\n${t("xq.input.how")}`;
  }
}

/** Parsed room message as an answer to a pending question. */
export type ExtensionUIAnswer =
  | { kind: "cancel" }
  | { kind: "value"; value: string }
  | { kind: "confirmed"; confirmed: boolean }
  | { kind: "invalid"; hint: string };

/** Map a room message onto a pending question's answer (issue #54). Pure —
 *  the confirm/select mapping rules are directly testable. The cancel word
 *  (取消/cancel, any case) matches after trimming; confirm accepts y/yes/n/no
 *  case-insensitively (anything else re-asks); select maps the 1-based index
 *  onto options (out of range re-asks); input/editor take the whole message
 *  as the value. */
export function parseExtensionUIAnswer(request: ExtensionUIRequestView, text: string): ExtensionUIAnswer {
  if (isCancelInput(text)) return { kind: "cancel" };
  switch (request.method) {
    case "confirm": {
      const normalized = text.toLowerCase();
      if (normalized === "y" || normalized === "yes") return { kind: "confirmed", confirmed: true };
      if (normalized === "n" || normalized === "no") return { kind: "confirmed", confirmed: false };
      return { kind: "invalid", hint: t("xq.confirm.invalid") };
    }
    case "select": {
      const options = request.options ?? [];
      const index = /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
      if (index >= 1 && index <= options.length) {
        return { kind: "value", value: options[index - 1]! };
      }
      return { kind: "invalid", hint: t("xq.select.invalid", { max: options.length }) };
    }
    default: // input / editor — the whole message is the answer
      return { kind: "value", value: text };
  }
}

/** 一道提问该种哪些表情(#270,与 hermes 的 prompt 表情组同思路):confirm 种
 *  ✅/❌;select 选项 ≤ 10 时种键帽数字 1️⃣…N(>10 不种 —— 数字表情条读不出
 *  「列表被截断」的语义,种了反而误导,spec #267);input/editor 不种。数组
 *  顺序即种植顺序(✅ 在前,与积压征询一致)。 */
function promptReactions(request: ExtensionUIRequestView): string[] {
  switch (request.method) {
    case "confirm":
      return [REACTION_APPROVE, REACTION_REJECT];
    case "select": {
      const options = request.options ?? [];
      return options.length <= 10 ? options.map((_, i) => digitKeycap(i + 1)) : [];
    }
    default:
      return [];
  }
}

/** reaction key → 悬置提问的等价答案(#270)。映射与文字通道的
 *  parseExtensionUIAnswer 同源:confirm 的 ✅/❌ 等价 y/n,select 的键帽数字
 *  (或裸数字,双形态见 reactions.ts)等价对应序号文字。返回 undefined =
 *  该 key 对这道题不适用(未知 key / confirm 上点数字 / select 上点 ✅❌ /
 *  序号越界),调用方静默 —— invalid 重问语义只属文字路径,reaction 路径
 *  只产生可直接提交的答案。 */
function reactionAnswer(request: ExtensionUIRequestView, key: string): Exclude<ExtensionUIAnswer, { kind: "invalid" }> | undefined {
  const verdict = parseReactionKey(key);
  switch (request.method) {
    case "confirm":
      if (verdict.kind === "approve") return { kind: "confirmed", confirmed: true };
      if (verdict.kind === "reject") return { kind: "confirmed", confirmed: false };
      return undefined;
    case "select": {
      if (verdict.kind !== "digit") return undefined;
      const options = request.options ?? [];
      if (verdict.index < 1 || verdict.index > options.length) return undefined;
      return { kind: "value", value: options[verdict.index - 1]! };
    }
    default:
      return undefined;
  }
}

// ===========================================================================
// ExtensionQuestions — 提问机状态机
// ===========================================================================

export interface ExtensionQuestionsDeps {
  /** 发帖出口:房间的回复通道(router 的 sendReply)。 */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** extension_ui 应答写入口:把回写载荷送到 pi 进程(生产实现是
   *  rpc.respondExtensionUI;注入为测试录制/失败注入留缝)。 */
  respond: (rpc: PiRpc, payload: ExtensionUIResponsePayload) => Promise<void>;
  /** 超时时长来源(extensionUiTimeoutMs(config) 派生;入队时读取一次)。 */
  timeoutMs: () => number;
  /** 重启生命周期订阅(与 RpcTransientState 同一接缝):子进程重启后,新
   *  进程对旧提问一无所知 —— 队列与计时器全部作废。缺省 = 不订阅。 */
  subscribeRestart?: (rpc: PiRpc, handler: (rpc: PiRpc) => void) => void;
  /**
   * 发出提问并取回底层 event_id 的**可选**缝(票03 #270,与 BacklogInbox 同
   * 名同形状,与 sendReaction **双双注入**才启用表情作答;缺省未注入 =
   * 功能禁用,提问照走 sendReply,行为与旧版一致)。返回 undefined =
   * transport 不给 id:提问照常有效,只是没有表情可点(文字通道始终可用)。
   */
  replyWithId?: (chatId: string, transport: string, text: string) => Promise<string | undefined>;
  /**
   * 在一条已发出的提问消息上种一个表情的**可选**缝(票03 #270,与
   * replyWithId 同门)。逐 emoji 的失败降级在本 module 内部处理(只 debug,
   * 不影响提问照发)。
   */
  sendReaction?: (chatId: string, eventId: string, emoji: string) => Promise<void>;
}

/** A question asked in a room and still awaiting the answer. FIFO per rpc —
 *  the oldest pending question is answered first. The target is captured at
 *  ask time so the answer/timeout routes back even if the default rpc's
 *  binding moves on to another prompter in between. */
export interface PendingExtensionQuestion {
  request: ExtensionUIRequestView;
  target: ReplyTarget;
  /** 提问时刻的日志视图:expire 从计时器触发,沿用提问时刻的标签。 */
  log: LeveledLogger;
  timer: NodeJS.Timeout;
  /** 提问消息自己的 event_id(replyWithId 拿到后回填,#270;未回填 = 无表情
   *  可点,reaction 点击一律静默)。 */
  promptEventId?: string;
}

export class ExtensionQuestions {
  private readonly deps: ExtensionQuestionsDeps;
  private readonly questions = new WeakMap<PiRpc, PendingExtensionQuestion[]>();
  private readonly watched = new WeakSet<PiRpc>();

  constructor(deps: ExtensionQuestionsDeps) {
    this.deps = deps;
  }

  /** 每进程 FIFO 提问队列(按需创建);首次触达时挂上重启失效订阅。 */
  private queue(rpc: PiRpc): PendingExtensionQuestion[] {
    if (this.deps.subscribeRestart && !this.watched.has(rpc)) {
      this.watched.add(rpc);
      this.deps.subscribeRestart(rpc, (r) => this.clear(r));
    }
    const queue = this.questions.get(rpc) ?? [];
    this.questions.set(rpc, queue);
    return queue;
  }

  /** Extension UI request intake (issue #54). Questions go to the bound room
   *  and park in the FIFO; without a binding they are answered cancelled
   *  right away (an unanswered dialog would hang the extension). notify is
   *  presented by level; the TUI-only display methods are ignored. */
  handle(request: ExtensionUIRequestView, rpc: PiRpc, target: ReplyTarget | undefined, log: LeveledLogger): void {
    switch (request.method) {
      case "confirm":
      case "select":
      case "input":
      case "editor": {
        if (!target) {
          log.warn(`[extension-ui] ${request.method} 请求无绑定房间,已代答取消 (id ${request.id})`);
          this.deps.respond(rpc, { id: request.id, cancelled: true }).catch((err: unknown) => {
            log.error(`[extension-ui] 代答取消失败 (id ${request.id}): ${errorMessage(err)}`);
          });
          return;
        }
        const entry: PendingExtensionQuestion = {
          request,
          target,
          log,
          timer: setTimeout(() => this.expire(rpc, entry), this.deps.timeoutMs()),
        };
        // A pending question must never keep the bridge process alive by itself.
        entry.timer.unref?.();
        this.queue(rpc).push(entry);
        this.postQuestion(rpc, entry);
        log.debug(`[extension-ui] ${request.method} 提问已发往房间 (id ${request.id})`);
        return;
      }
      case "notify": {
        // Presentational: only warning/error reach the room, info stays in
        // the log — the room is not a dumping ground for progress chatter.
        const level = request.notifyType ?? "info";
        const message = truncateLine(request.message ?? "", 500);
        if (level === "warning" || level === "error") {
          if (target) {
            const icon = level === "error" ? "🔴" : "⚠️";
            this.deps.sendReply(target.chatId, target.transport, `${icon} ${t("xq.notify", { message })}`).catch((err: unknown) => {
          logger.warn(`[xq] 问题通知发送失败: ${errorMessage(err)}`);
        });
          } else {
            log.warn(`[extension-ui] 扩展通知(${level},无绑定房间): ${message}`);
          }
        } else {
          log.debug(`[extension-ui] 扩展通知(info): ${message}`);
        }
        return;
      }
      default:
        // setStatus / setWidget / setTitle / set_editor_text — TUI-only display.
        log.debug(`[extension-ui] ${request.method} 为 TUI 专属展示,已忽略`);
        return;
    }
  }

  /** 收到房间消息,尝试作答(spec #99 票3)。严格 FIFO:只有最老的悬置提问
   *  所属房间与消息房间一致时才消费;否则消息不归提问机(交还管道继续走)。
   *  返回 true = 消息已被提问机消费(管道终止)。 */
  async deliver(rpc: PiRpc, text: string, msg: ExternalMessage, log: LeveledLogger): Promise<boolean> {
    const queue = this.queue(rpc);
    const oldest = queue[0];
    if (!oldest || oldest.target.chatId !== msg.chatId) return false;
    await this.commitAnswer(rpc, queue, oldest, text, msg, log);
    return true;
  }

  /** 把提问卡发到房间(#270):双缝齐备且本题有表情可种时走 replyWithId 拿
   *  event_id,拿到后回填 promptEventId 并 fire-and-forget 种上表情组;其余
   *  情形(缝未注入、input/editor、select >10)一律旧 sendReply 通道。发送
   *  失败只 warn(题没送到,日志里可见);种表情失败只 debug(题已送到,
   *  文字通道始终可用)。 */
  private postQuestion(rpc: PiRpc, entry: PendingExtensionQuestion): void {
    const { chatId, transport } = entry.target;
    const text = extensionUIQuestionText(entry.request);
    const emojis = promptReactions(entry.request);
    const { replyWithId, sendReaction } = this.deps;
    if (!replyWithId || !sendReaction || emojis.length === 0) {
      void this.deps.sendReply(chatId, transport, text).catch((err: unknown) => {
        logger.warn(`[xq] 问题卡片发送失败(用户看不到这道题): ${errorMessage(err)}`);
      });
      return;
    }
    void replyWithId(chatId, transport, text)
      .then((eventId) => {
        if (!eventId) return; // transport 不给 id:提问照常,只是没有表情可点
        // 竞态护栏:then 落定前若已被回答/超时/重启作废(不在队列),旧 id
        // 不回填 —— 残留消息上的点击必须静默。
        if (!this.questions.get(rpc)?.includes(entry)) return;
        entry.promptEventId = eventId;
        for (const emoji of emojis) {
          sendReaction(chatId, eventId, emoji).catch((err: unknown) =>
            logger.debug(`[xq] 表情种植失败 (${emoji}): ${errorMessage(err)}`)
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn(`[xq] 问题卡片发送失败(用户看不到这道题): ${errorMessage(err)}`);
      });
  }

  /**
   * reaction 应答入口(票03 #270):按 (房间, 提问 event_id) 精确匹配悬置
   * 提问。FIFO 最老优先不变量不变 —— 只有队列最老的提问有资格,且
   * targetEventId 必须等于它自己的 promptEventId(younger 提问消息上的点击
   * 一律静默;promptEventId 未回填时同样静默)。✅/❌ 等价文字 y/n,键帽数
   * 字等价对应序号文字;confirm 上点数字、select 上点 ✅❌、未知 key、序号
   * 越界一律静默(噪音策略:invalid 重问语义只属文字路径)。返回 true =
   * 该点击已被提问机消费。
   */
  deliverReaction(rpc: PiRpc, chatId: string, targetEventId: string, key: string): boolean {
    const queue = this.questions.get(rpc);
    const oldest = queue?.[0];
    if (!oldest || oldest.target.chatId !== chatId) return false;
    if (!oldest.promptEventId || oldest.promptEventId !== targetEventId) return false;
    const answer = reactionAnswer(oldest.request, key);
    if (!answer) return false;
    // reaction 不走消息管道:回执失败无处上抛,整体 fire-and-forget + debug
    // (与 BacklogInbox.answerByReaction 同一口径)。
    void this.commitParsedAnswer(rpc, queue!, oldest, answer, chatId, oldest.target.transport, oldest.log).catch(
      (err: unknown) => logger.debug(`[xq] reaction 应答收尾失败: ${errorMessage(err)}`)
    );
    return true;
  }

  /** 进程重启失效:新子进程对旧提问一无所知 —— 队列与计时器全部作废,
   *  房间下一条普通消息回到 prompt 通道,而不是给死提问当答案。 */
  clear(rpc: PiRpc): void {
    const queue = this.questions.get(rpc);
    if (queue) {
      for (const question of queue) clearTimeout(question.timer);
      this.questions.delete(rpc);
    }
  }

  /** Timeout expiry (issue #54): answer cancelled on the user's behalf, tell
   *  the room, and drop the question. A no-op when it was answered already. */
  private expire(rpc: PiRpc, entry: PendingExtensionQuestion): void {
    const queue = this.questions.get(rpc);
    const index = queue?.indexOf(entry) ?? -1;
    if (!queue || index === -1) return; // answered or cancelled in the meantime
    queue.splice(index, 1);
    const title = truncateLine(entry.request.title ?? t("xq.untitled"), 80);
    entry.log.info(`[extension-ui] 提问超时未答,已代答取消 (id ${entry.request.id})`);
    this.deps.respond(rpc, { id: entry.request.id, cancelled: true }).catch((err: unknown) => {
      entry.log.error(`[extension-ui] 超时代答回写失败 (id ${entry.request.id}): ${errorMessage(err)}`);
    });
    this.deps.sendReply(entry.target.chatId, entry.target.transport, t("xq.expired", { title })).catch((err: unknown) => {
      logger.warn(`[xq] 过期回执发送失败: ${errorMessage(err)}`);
    });
  }

  /** Commit an answer to the oldest pending question (issue #54): parse the
   *  room message and hand off. Invalid input re-asks without dequeuing —
   *  that semantics belongs to the text path only (#270 的 reaction 路径在
   *  deliverReaction 里先行解析,不适用项直接静默)。 */
  private async commitAnswer(rpc: PiRpc, queue: PendingExtensionQuestion[], entry: PendingExtensionQuestion, text: string, msg: ExternalMessage, log: LeveledLogger): Promise<void> {
    const answer = parseExtensionUIAnswer(entry.request, text);
    if (answer.kind === "invalid") {
      await this.deps.sendReply(msg.chatId, msg.transport, answer.hint);
      return;
    }
    await this.commitParsedAnswer(rpc, queue, entry, answer, msg.chatId, msg.transport, log);
  }

  /** 提交已解析答案的全部语义(文字与 reaction 两路共用,#270):出队、写
   *  回 extension_ui_response、房间回执。respond 失败回「答案无法回传」并
   *  保持已出队(房间不留回答幽灵);await 语义由调用方定 —— 文字路径沿管
   *  道上抛,reaction 路径整体 fire-and-forget(见 deliverReaction)。invalid
   *  不进这里:文字路径先拦截重问,reaction 路径根本不产生 invalid。 */
  private async commitParsedAnswer(rpc: PiRpc, queue: PendingExtensionQuestion[], entry: PendingExtensionQuestion, answer: Exclude<ExtensionUIAnswer, { kind: "invalid" }>, chatId: string, transport: string, log: LeveledLogger): Promise<void> {
    queue.splice(queue.indexOf(entry), 1);
    clearTimeout(entry.timer);
    const payload: ExtensionUIResponsePayload =
      answer.kind === "cancel"
        ? { id: entry.request.id, cancelled: true }
        : answer.kind === "confirmed"
          ? { id: entry.request.id, confirmed: answer.confirmed }
          : { id: entry.request.id, value: answer.value };
    try {
      await this.deps.respond(rpc, payload);
    } catch (err) {
      log.error(`[extension-ui] 应答回写失败 (id ${entry.request.id}): ${errorMessage(err)}`);
      await this.deps.sendReply(chatId, transport, t("xq.answer.lost"));
      return;
    }
    await this.deps.sendReply(
      chatId,
      transport,
      answer.kind === "cancel" ? t("xq.answer.cancelled") : t("xq.answer.ok")
    );
  }
}
