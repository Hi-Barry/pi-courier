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

/** 在途捕获槽:rpc、终答出口与重启失效订阅的退订柄(崩溃失效用)。 */
interface CaptureSlot {
  rpc: PiRpc;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  /** 重启生命周期订阅的退订柄:settle / prompt 失败 / 重启任一路径收尾
   *  时撤销,长命进程不攒监听器。 */
  offRestart?: () => void;
}

/** 交接卡的每进程记账(issue #122):「已完成对话轮」计数 + 在途捕获槽。
 *  忙拒保证同一时刻至多一个捕获在飞;/stop 打断会以失败轮收场,捕获随之
 *  reject,不会悬挂;换会话(/new //clear)reset() 归零。状态与生命周期
 *  单点持有,router 只编排投递与门控。 */
export class RecapLedger {
  private turns = new WeakMap<PiRpc, number>();
  private capture: CaptureSlot | undefined;

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
   *  捕获并 reject,捕获槽不留悬案。
   *
   *  崩溃失效(票 fix-recap-capture-crash-invalidation):prompt 应答已收
   *  后子进程崩溃/重启,turn_end 永远不会来 —— 捕获随重启生命周期订阅
   *  (与 bash 自管通道/compact 同一接缝,PiRpc.onRestarted)自行 reject 并
   *  清槽。Ledger 随单例 router 跨子进程存活,单槽悬挂曾让所有房间的
   *  /recap 与 /new 自动出卡永久 RecapBusyError(全局假忙)。可选调用:
   *  未接生命周期的 rpc(测试 mock 等)退化为旧行为,不再多依赖一步。 */
  startCapture(rpc: PiRpc): Promise<string> {
    if (this.capture) {
      // 上一张卡未 settle 就再来一张:原实现直接覆盖槽位,旧调用永远悬挂
      // (悬案)。忙拒绝让两次调用都有明确结局,调用方既有 RecapBusyError
      // 路径照常回执(审计稳定性批 票17)。
      return Promise.reject(new RecapBusyError());
    }
    return new Promise<string>((resolve, reject) => {
      const slot: CaptureSlot = { rpc, resolve, reject };
      this.capture = slot;
      // 槽实例引用判代次:重启触发时本捕获若已被结算/被新捕获替换,不动。
      slot.offRestart = rpc.onRestarted?.(() => {
        if (this.capture !== slot) return;
        this.capture = undefined;
        slot.offRestart?.(); // 崩溃杀掉的捕获同样撤销订阅,重启循环不攒监听器
        reject(new Error("pi process restarted; the recap capture was aborted"));
      });
      rpc.prompt(recapPromptText()).catch((err: unknown) => {
        if (this.capture === slot) {
          this.capture = undefined;
          slot.offRestart?.();
        }
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
    capture.offRestart?.(); // 已结算:撤销重启失效订阅,监听器不泄漏
    const body = turn.text?.trim();
    if (body) capture.resolve(body);
    else capture.reject(new RecapEmptyError());
    return "settled";
  }
}
