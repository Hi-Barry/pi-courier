/**
 * Session handoff cards (issue #122): /recap summarizes the CURRENT session
 * into ≤5 bullets before /new wipes the context — and (opt-in, `recap.onNew`)
 * the same card is generated automatically before a /new //clear. The
 * summary is a REAL model call through the live process: the router sends a
 * prompt and captures the turn's final answer from the agent event flow
 * (turn_end), so the card says what the session's own agent remembers.
 *
 * The card is a bonus, never a dependency: generation failure must never
 * block /new (fail-open is pinned by tests), and a busy process refuses
 * /recap outright instead of racing a running task with steering semantics
 * — by the time a queued recap would run, "the current session" it was
 * asked about may no longer exist.
 */

import { t } from "../i18n/index.js";
import type { PiRpc } from "./pi-rpc.js";

/** 触发门槛:至少这么多「已完成对话轮」才值得出卡(/new 自动出卡同阈)。 */
export const RECAP_MIN_TURNS = 2;

/** 忙碌拒绝:/recap 不与在跑任务争抢(见模块头)。 */
export class RecapBusyError extends Error {
  constructor() {
    super("recap refused: the process is streaming");
  }
}

/** 空会话:没有可总结的对话轮(或总结出来是空的)。 */
export class RecapEmptyError extends Error {
  constructor() {
    super("recap refused: nothing to summarize yet");
  }
}

/** 发给当前进程的总结指令(一次真实模型调用,约几百 token)。 */
export function recapPromptText(): string {
  return t("recap.prompt");
}

export interface RecapCardInput {
  /** 卡片标题(时间戳 + 会话短标识)。 */
  title: string;
  /** 模型给出的要点正文(原样引用,不再加工)。 */
  body: string;
  /** 项目名(多工程抄送管理房时的前缀;缺省不加)。 */
  project?: string;
  /** 上下文占用一行(现拉现用;缺省省略)。 */
  context?: string | null;
}

/** 卡片渲染纯函数:标题、正文、可选项目前缀与上下文一行。 */
export function renderRecapCard(input: RecapCardInput): string {
  const header = input.project
    ? t("recap.card.titled", { project: input.project, title: input.title })
    : t("recap.card.plain", { title: input.title });
  const lines = [header, "", input.body.trim()];
  if (input.context) {
    lines.push("", t("recap.card.context", { context: input.context }));
  }
  return lines.join("\n");
}

/** 标题:本地时间 + 会话短标识(可读性优先,精度到分钟)。 */
export function recapCardTitle(sessionHint?: string, now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const hint = sessionHint ? ` · #${sessionHint.slice(0, 8)}` : "";
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${date} ${hh}:${mm}${hint}`;
}

/** 管理房抄送前缀(多工程):`📋 <项目名> 交接卡`。 */
export function recapCcPrefix(project: string): string {
  return t("recap.cc.prefix", { project });
}

/** 交接卡的每进程记账(issue #122):「已完成对话轮」计数 + 在途捕获槽。
 *  忙拒保证同一时刻至多一个捕获在飞;/stop 打断会以失败轮收场,捕获随之
 *  reject,不会悬挂;换会话(/new //clear)reset() 归零。状态与生命周期
 *  单点持有,router 只编排投递与门控。 */
export class RecapLedger {
  private turns = new WeakMap<PiRpc, number>();
  private capture: { rpc: PiRpc; resolve: (text: string) => void; reject: (err: Error) => void } | undefined;

  count(rpc: PiRpc): number {
    return this.turns.get(rpc) ?? 0;
  }

  /** turn_end 计一轮。 */
  increment(rpc: PiRpc): void {
    this.turns.set(rpc, this.count(rpc) + 1);
  }

  /** 换会话(/new //clear)归零:交接卡总结的是「当前会话」,旧账不作数。 */
  reset(rpc: PiRpc): void {
    this.turns.set(rpc, 0);
  }

  /** 发总结 prompt 并等终答(turn_end 的最终文本)。prompt 发送失败即撤销
   *  捕获并 reject,捕获槽不留悬案。 */
  startCapture(rpc: PiRpc): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.capture = { rpc, resolve, reject };
      rpc.prompt(recapPromptText()).catch((err: unknown) => {
        if (this.capture?.rpc === rpc) this.capture = undefined;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** turn_end 结算在途捕获:"none" = 不涉及本进程,调用方走正常回复路径;
   *  "wait" = 工具循环中间轮,捕获保持继续等;"settled" = 已按终答文本
   *  resolve(空文本 reject RecapEmptyError)——卡片投递替代原生回复,
   *  总结文本不重复发房间。 */
  settleCapture(rpc: PiRpc, turn: { text?: string | null; pendingTools: boolean }): "none" | "wait" | "settled" {
    if (this.capture?.rpc !== rpc) return "none";
    if (turn.pendingTools) return "wait";
    const capture = this.capture;
    this.capture = undefined;
    const body = turn.text?.trim();
    if (body) capture.resolve(body);
    else capture.reject(new RecapEmptyError());
    return "settled";
  }
}
