/**
 * 离线收件箱(issue #113)的状态 module:积压缓冲、征询定时器、悬置待答
 * 三件套与超时/执行/忽略/结算语义单点持有 —— router 的 backlogInbox /
 * backlogAnswer 两个阶段只做转发,授权门控仍由管道前置阶段裁决(授权在
 * 管道里,不在这里;本 module 只会被授权后的阶段调用)。与 RpcTransientState
 * 同构:构造时注入回执/投递/审计出口,内部纯内存、不 import 传输层。
 */
import { inboxMode } from "../config.js";
import { t } from "../i18n/index.js";
import { isExecuteInput, isIgnoreInput } from "../i18n/parse.js";
import { logger } from "../logger.js";
import type { ExternalMessage, MsgBridgeConfig } from "../types.js";

const BACKLOG_SETTLE_MS = 5_000;
const BACKLOG_CONFIRM_TIMEOUT_MS = 10 * 60_000;

export interface BacklogInboxOptions {
  reply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** 按到达序原样再注入——router 提供自身入口(剥 replayed 标记走全管道)。 */
  deliver: (entries: ExternalMessage[]) => Promise<void>;
  /** 当前生效配置(auto 分支与 off 兜底都随读随判)。 */
  config: () => MsgBridgeConfig;
  /** 「执行」落账钩子(#124 审计,#113 回填);缺省 = 不审计。 */
  onExecute?: (msg: ExternalMessage, count: number) => void;
}

export class BacklogInbox {
  private buffers = new Map<string, ExternalMessage[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private awaiting = new Map<string, { entries: ExternalMessage[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(private options: BacklogInboxOptions) {}

  /** 积压清单的一行预览:文本收成单行截断;非文本载荷与 📥 日志同形。 */
  private preview(msg: ExternalMessage): string {
    const raw = msg.payload.kind === "text" ? msg.payload.text : `[${msg.payload.kind}]`;
    const oneLine = raw.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
  }

  /** backlogInbox 阶段入口:replayed 消息进缓冲(返回 true = 已处理);
   *  实时消息若本房有缓冲则先结算(等回放波就不必了);off 模式连缓冲都
   *  不进,交回管道(transport 根本不该转发积压,这里挡手喂的兜底)。 */
  accept(msg: ExternalMessage): boolean {
    if (msg.replayed) {
      if (inboxMode(this.options.config()) === "off") return false;
      this.buffer(msg);
      return true;
    }
    if (this.buffers.has(msg.chatId)) this.settle(msg.chatId);
    return false;
  }

  /** backlogAnswer 阶段入口:「执行/忽略」消费悬置征询(返回 true = 消息
   *  已处理,不得漏到 pi 当对话);其它输入照常走管道,征询继续挂着等。 */
  async answer(text: string, msg: ExternalMessage): Promise<boolean> {
    const pending = this.awaiting.get(msg.chatId);
    if (!pending) return false;
    if (isExecuteInput(text)) {
      this.awaiting.delete(msg.chatId);
      clearTimeout(pending.timer);
      // 审计(#124)与投递的先后无所谓:投递是 fire-and-forget,先落账。
      this.options.onExecute?.(msg, pending.entries.length);
      void this.options
        .deliver(pending.entries)
        .catch((err: unknown) => logger.error(`backlog delivery failed: ${(err as Error).message}`));
      return true;
    }
    if (isIgnoreInput(text)) {
      this.awaiting.delete(msg.chatId);
      clearTimeout(pending.timer);
      // 与旧实现逐字节一致:回执 await 落定,发送失败沿管道上抛(不吞)。
      await this.options.reply(msg.chatId, msg.transport, t("inbox.ignored", { count: pending.entries.length }));
      return true;
    }
    return false;
  }

  private buffer(msg: ExternalMessage): void {
    const buffer = this.buffers.get(msg.chatId) ?? [];
    buffer.push(msg);
    this.buffers.set(msg.chatId, buffer);
    if (!this.timers.has(msg.chatId)) {
      this.timers.set(msg.chatId, setTimeout(() => this.settle(msg.chatId), BACKLOG_SETTLE_MS));
    }
  }

  /** 积压清单逐行渲染(user + 单行预览)。 */
  private renderLines(entries: ExternalMessage[]): string {
    return entries.map((e) => t("inbox.entry.line", { user: e.username, preview: this.preview(e) })).join("\n");
  }

  /** 结算:首条积压后 5s(等回放波灌完)或本房首条实时消息到达。auto 模式
   *  告知后按序执行;confirm(默认)汇总征询,「执行」按序处理 /「忽略」
   *  丢弃 / 超时视为忽略。新积压波并入旧待答(重开一轮计时与征询)。 */
  private settle(chatId: string): void {
    const timer = this.timers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(chatId);
    }
    const entries = this.buffers.get(chatId);
    if (!entries || entries.length === 0) return;
    this.buffers.delete(chatId);
    const lines = this.renderLines(entries);
    const transport = entries[0]!.transport;

    if (inboxMode(this.options.config()) === "auto") {
      // 告知后直接按序执行(部署者明确选择过;`!`/bash 类消息的惊吓风险
      // 由部署者自担)。
      void this.options
        .reply(chatId, transport, t("inbox.auto.notice", { count: entries.length, lines }))
        .then(() => this.options.deliver(entries))
        .catch((err: unknown) => logger.error(`backlog auto-delivery failed: ${(err as Error).message}`));
      return;
    }

    const prior = this.awaiting.get(chatId);
    if (prior) {
      clearTimeout(prior.timer);
      prior.entries.push(...entries);
    }
    const merged = prior?.entries ?? entries;
    const mergedLines = this.renderLines(merged);
    const confirmTimer = setTimeout(() => {
      // 超时默认忽略:静默丢弃,不发补充通知(征询文案已写明规则)。
      this.awaiting.delete(chatId);
    }, BACKLOG_CONFIRM_TIMEOUT_MS);
    this.awaiting.set(chatId, { entries: merged, timer: confirmTimer });
    void this.options
      .reply(
        chatId,
        transport,
        t("inbox.confirm.prompt", {
          count: merged.length,
          lines: mergedLines,
          minutes: BACKLOG_CONFIRM_TIMEOUT_MS / 60_000,
        })
      )
      .catch((err: unknown) => {
        // 征询发不出去(极端时序)等于没人能批准 —— 按忽略处理,积压不留悬案。
        this.awaiting.delete(chatId);
        clearTimeout(confirmTimer);
        logger.warn(`backlog confirm prompt failed, backlog discarded: ${(err as Error).message}`);
      });
  }
}
