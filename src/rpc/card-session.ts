/**
 * CardSession — 同一条 Matrix 编辑缝(editReply/sendLiveCard)上的两台活卡
 * 状态机(#354,评审卡2:机件沉到缝下)。
 *
 * 此前两台机器的机件(代次捕获、在途写回作废、降级标志、重启失效)复制
 * 两份摊在 router 闭包 —— 活卡 bug 曾连续三条 spec(#235/#242/#248)回炉,
 * 修复面是 router 两段;「重启懒订阅 + WeakSet 去重」样板另有三张 WeakSet。
 * 本模块把机件收成单点:
 *  - CardGeneration:出站代次(捕获/stale/递增),两台机器共用同一不变量
 *    「凡是清卡路径都递增,窗口内的迟到写回一律作废」;
 *  - ToolTurnCards:工具循环活卡(单卡 + FIFO 出站链 + 降级逐条直发 +
 *    溢出滚动),策略循环随类整体迁入;
 *  - WorkflowProgressCards:工作流进度卡(按 runId 多卡账本 + 节流 +
 *    降级放大间隔重试 + 终态 finalized + 旧 run 中断编辑)。
 *
 * 策略差异是本质的(出站调度、降级行为、多卡/单卡、节流/终态),以两个类
 * 显式表达,不硬捏成一个参数化巨类;统一的是机件与失效语义。行为逐字节
 * 不变 —— router-livecard / workflow 卡片系列既有测试为主证据。
 */

import { errorMessage } from "../errors.js";
import { splitMessage } from "../formatting.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import type { ReplyTarget } from "../types.js";
import { parseWorkflowProgress } from "../workflow/adapter.js";
import { renderWorkflowProgress, type WorkflowCardLabels } from "../workflow/render.js";
import { isTerminal, type WorkflowProgressIR, type WorkflowRunStatus } from "../workflow/types.js";
import type { PiRpc } from "./pi-rpc.js";
import type { RpcRestartHooks } from "./restart-hooks.js";

/** 编辑缝的最小形状(standalone 组合根注入;缺席 = 机器整体禁用)。 */
export interface CardEditSeam {
  editReply: (chatId: string, transport: string, eventId: string, text: string) => Promise<void>;
  sendLiveCard: (chatId: string, transport: string, text: string) => Promise<string | undefined>;
}

/** 直发通道(降级逐条直发用;与普通回复同一条 transport FIFO)。 */
export type CardDirectSend = (chatId: string, transport: string, text: string) => Promise<void>;

/**
 * 出站代次(#242 意见2 → #354 单点):清卡路径递增;步骤发起时捕获、写回
 * 前校验 —— 「开卡/编辑挂起期间恰好跨越清卡点(前一序列中止后立即开新
 * 对话的亚秒窗口)」的迟到状态写回一律作废,杜绝「在途开卡把刚清掉的
 * 活卡写回新对话」。
 */
export class CardGeneration {
  private value = 0;

  /** 步骤发起时捕获;写回前以 stale() 校验。 */
  capture(): number {
    return this.value;
  }

  stale(captured: number): boolean {
    return this.value !== captured;
  }

  /** 清卡单一入口的代次半边(#242 评审整改):删除与递增同进同出,不留
   *  「只删不递增」的复活窗口。 */
  bump(): void {
    this.value += 1;
  }
}

// ── 工具循环活卡(issue #235 票2)──────────────────────────────────────────
// 工具循环的中间回合聚合进同一张「工作中」卡片:首回合发新卡(sendLiveCard
// 取回 event_id),后续中间回合对同一事件就地编辑追加(editReply,回合间
// 以空行连接),终答回合与轮次边界(agent_start)清卡。状态按「rpc 的绑定」
// 同一 WeakMap 生命周期模型记账;绑定释放逻辑不动,活卡生命周期由回合语义
// 与轮次边界驱动。缺省未注入 editReply/sendLiveCard = 聚合整体禁用,行为
// 与现状逐字节一致(旧部署、既有测试零影响)。

interface LiveCard {
  /** 活卡新卡的底层 event_id —— 本序列的后续编辑都指向它。 */
  eventId: string;
  /** 已累积文本:编辑是「设为全文」语义,累积在这里维护。 */
  text: string;
}

interface LiveCardState {
  card?: LiveCard;
  /** 序列级降级标志(issue #235 票3):编辑抛错置位 —— 同轮对话内后续
   *  中间回合全部逐条直发(旧行为);下一轮 agent_start 随活卡一并清零,
   *  重新尝试聚合。 */
  degraded: boolean;
}

export interface ToolTurnCardsDeps {
  /** 编辑缝;缺席 = turn 恒 no-op(聚合关闭的部署/测试)。 */
  seam?: CardEditSeam;
  /** 降级直发通道(与普通回复同一条 per-room FIFO,顺序由架构保证)。 */
  sendReply: CardDirectSend;
  /** 重启失效钩子(键 "tool-turn-card")。 */
  restart: RpcRestartHooks;
}

/** 单条编辑/开卡的目标上限:与 transport 层单条上限同源(4000)。 */
const LIVE_CARD_SPLIT_LIMIT = 4000;

export class ToolTurnCards {
  private cards = new WeakMap<PiRpc, LiveCardState>();
  private generations = new WeakMap<PiRpc, CardGeneration>();
  /** 活卡出站链(per-rpc FIFO,与 transport 的 enqueueSend 同构):中间回合的
   *  「开卡/编辑」严格按 turn_end 到达顺序结算 —— 后一回合的决策(有无活卡)
   *  必须看到前一回合的结果,连发的两个中间回合才不会各开一张卡。step 自吞错,
   *  链上每步独立结算、失败不传染。 */
  private chains = new WeakMap<PiRpc, Promise<void>>();

  constructor(private readonly deps: ToolTurnCardsDeps) {}

  private generationOf(rpc: PiRpc): CardGeneration {
    const gen = this.generations.get(rpc) ?? new CardGeneration();
    this.generations.set(rpc, gen);
    return gen;
  }

  /** 序列级降级标志(turn_end 的降级整回合直发预判;spec #297 评审整改
   *  —— 「每回合一条」覆盖混合段回合,段落级结算只在非降级态进行)。 */
  isDegraded(rpc: PiRpc): boolean {
    return this.cards.get(rpc)?.degraded === true;
  }

  /** 清卡单一入口(spec #242 评审整改):凡是清活卡的路径(轮次边界、终答
   *  收敛、交接卡捕获收敛、子进程重启回调)一律经此 —— 删除与代次递增
   *  同进同出,任何一个清卡点之后在途步骤的迟到写回都作废。 */
  clear(rpc: PiRpc): void {
    this.cards.delete(rpc);
    this.generationOf(rpc).bump();
  }

  /** 活卡出站链入队(降级整回合直发也走同一条链,顺序不变)。 */
  enqueue(rpc: PiRpc, step: () => Promise<void>): void {
    const prev = this.chains.get(rpc) ?? Promise.resolve();
    const run = prev.then(step, step);
    this.chains.set(rpc, run.then(() => undefined, () => undefined));
  }

  /** 中间回合的活卡出站(应在出站链上结算):无卡开卡、有卡编辑追加。 */
  turn(rpc: PiRpc, target: ReplyTarget, text: string): Promise<void> {
    const { editReply, sendLiveCard } = this.deps.seam ?? {};
    if (!editReply || !sendLiveCard) return Promise.resolve();
    const sendReply = this.deps.sendReply;
    const generation = this.generationOf(rpc);
    return (async () => {
      // 代次捕获(spec #242 意见2):本步骤全程以此为准,写回前校验。
      const captured = generation.capture();
      const stale = (): boolean => generation.stale(captured);
      const state = this.cards.get(rpc);
      if (state?.degraded) {
        // 降级中的序列退回逐条直发(旧行为;与聚合关闭时的中间回合同路)。
        for (const chunk of splitMessage(text, LIVE_CARD_SPLIT_LIMIT)) {
          await sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }
        return;
      }
      if (!state?.card) {
        // 无活卡:发新卡并记录 event_id。拿不到 event_id(发送失败被吞/非
        // Matrix transport)仅记日志、不进活卡状态 —— 下一中间回合自然重试
        // 开卡(票3:发新卡失败仅记日志、不进活卡状态)。
        const eventId = await sendLiveCard(target.chatId, target.transport, text).catch(() => undefined);
        if (!eventId) {
          logger.debug(`live card: no event_id for ${target.chatId} — next turn retries opening one`);
          return;
        }
        // 在途跨越清卡点:卡片可能已发出,但状态一律不写回(作废)。
        if (stale()) return;
        this.deps.restart.once(rpc, "tool-turn-card", () => this.clear(rpc));
        this.cards.set(rpc, { card: { eventId, text }, degraded: false });
        return;
      }
      const card = state.card;
      const merged = `${card.text}\n\n${text}`;
      // 溢出滚动(票3):「活卡累积 + 新回合文本」超单条上限 → 先对旧卡做
      // 最后一次编辑(定稿为既有累积内容),再将新回合文本按现行拆分口径
      // 切片 —— 前 n-1 片普通新消息直发,最后一片开新卡作新活卡(新文本
      // 本身不超限时只有这一片 = 定稿后整体开新卡)。任意时刻只有最新一张
      // 卡可被编辑:旧卡 event_id 不再出现在后续编辑调用里。
      if (splitMessage(merged, LIVE_CARD_SPLIT_LIMIT).length > 1) {
        const chunks = splitMessage(text, LIVE_CARD_SPLIT_LIMIT);
        try {
          await editReply(target.chatId, target.transport, card.eventId, card.text);
        } catch (err) {
          // 定稿失败 = 编辑失败同语义:降级 + 本回合文本逐条直发补上。
          logger.warn(`live card finalize failed for ${target.chatId}: ${errorMessage(err)}`);
          if (!stale()) this.cards.set(rpc, { degraded: true });
          for (const chunk of chunks) {
            await sendReply(target.chatId, target.transport, chunk).catch(() => {});
          }
          return;
        }
        for (const chunk of chunks.slice(0, -1)) {
          await sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }
        const lastChunk = chunks[chunks.length - 1]!;
        const eventId = await sendLiveCard(target.chatId, target.transport, lastChunk).catch(() => undefined);
        if (!eventId) {
          // 滚动开卡失败(spec #242 意见1):旧卡已定稿不再可编辑,清掉活卡
          // 状态让下一中间回合走「无活卡→开卡」自然重试 —— 与无卡开卡失败
          // 分支同一不变量:失败即不留状态;否则会拿已定稿旧卡的 event_id
          // 继续编辑,违反「任意时刻只有最新一张卡可被编辑」。
          this.cards.delete(rpc);
          logger.debug(`live card: no event_id for rolled-over card (${target.chatId}) — next turn retries opening one`);
          return;
        }
        if (stale()) return;
        this.cards.set(rpc, { card: { eventId, text: lastChunk }, degraded: false });
        return;
      }
      try {
        await editReply(target.chatId, target.transport, card.eventId, merged);
      } catch (err) {
        // 失败降级(票3):编辑抛错(不分类、不重试)→ 清活卡 + 置序列级
        // 降级标志 —— 同轮对话内后续中间回合全部逐条直发(旧行为),下一轮
        // agent_start 随活卡一并清零重新聚合。本回合文本逐条直发补上:活卡
        // 停在旧累积,新增内容不能丢(User story 7「不丢回复」)。
        logger.warn(`live card edit failed for ${target.chatId}: ${errorMessage(err)}`);
        if (!stale()) this.cards.set(rpc, { degraded: true });
        for (const chunk of splitMessage(text, LIVE_CARD_SPLIT_LIMIT)) {
          await sendReply(target.chatId, target.transport, chunk).catch(() => {});
        }
        return;
      }
      card.text = merged;
    })();
  }
}

// ── 工作流进度活卡(工作流状态机票3)─────────────────────────────────────
// dwf 进度快照聚合进同一张活卡就地刷新;与工具循环活卡完全并列、互不触碰
// —— 本账本不进工具卡的清卡,工具卡的清卡也不动本账本(agent_start /
// turn_end 的清卡是工具循环活卡的轮次语义,工作流卡的生命周期由 runId
// 驱动)。输入只有内部 IR(parseWorkflowProgress 产出),渲染只有
// renderWorkflowProgress;本文件不出现 dwf 事件字符串与快照字段名。

interface WorkflowCard {
  /** 卡片 event_id,同 runId 的后续编辑都指向它 */
  eventId: string;
  /** 已渲染文本(最后一次成功出站的完整内容) */
  text: string;
  /** 终态已落卡:永不再编辑(不复活) */
  finalized: boolean;
  /** 编辑失败置位:后续快照按放大间隔重试,不降级逐条直发 */
  degraded: boolean;
  /** 上次成功编辑时间(Date.now()),节流基准 */
  lastEditAt: number;
}

interface WorkflowCardLedger {
  cards: Map<string, WorkflowCard>;
  /** 当前活跃 run:新 runId 到来且旧卡未终态时,旧卡补一次中断编辑 */
  activeRunId?: string;
}

export interface WorkflowProgressCardsDeps {
  /** 编辑缝;缺席 = handle 恒 no-op。 */
  seam?: CardEditSeam;
  /** 启用判定(配置开 + 缝齐备;router 现读现判)。 */
  isEnabled: () => boolean;
  /** 节流间隔(router 以 store 现读现判)。 */
  throttleMs: () => number;
  /** 绑定解析(replay/未绑定 → undefined,快照安全旁路)。 */
  targetFor: (rpc: PiRpc) => ReplyTarget | undefined;
  /** 文案组装(router 一次组装,当前 locale)。 */
  labels: WorkflowCardLabels;
  /** 降级重试间隔(毫秒):数值单一来源在 config。 */
  degradedRetryMs: number;
  /** 重启失效钩子(键 "workflow-card")。 */
  restart: RpcRestartHooks;
}

export class WorkflowProgressCards {
  private ledgers = new WeakMap<PiRpc, WorkflowCardLedger>();
  private generations = new WeakMap<PiRpc, CardGeneration>();
  /** 累积合并的底稿(按 rpc+runId):快照的 agents 是活动视图,新快照
   *  以此为底 upsert,完成/跳过的子代理才不会从卡片上消失。 */
  private lastIr = new WeakMap<PiRpc, Map<string, WorkflowProgressIR>>();
  /** 上次渲染的归一状态(按 rpc+runId):状态翻转检测的记账。 */
  private lastStatus = new WeakMap<PiRpc, Map<string, WorkflowRunStatus>>();

  constructor(private readonly deps: WorkflowProgressCardsDeps) {}

  private generationOf(rpc: PiRpc): CardGeneration {
    const gen = this.generations.get(rpc) ?? new CardGeneration();
    this.generations.set(rpc, gen);
    return gen;
  }

  /** 清账本 + 递增代次的单一入口(子进程重启回调):在途出站的迟到写回
   *  一律作废。 */
  private invalidate(rpc: PiRpc): void {
    this.generationOf(rpc).bump();
    this.ledgers.delete(rpc);
  }

  /** 进度快照 → 工作流卡(编辑链异步结算,fire-and-forget;失败只记账)。 */
  handle(rpc: PiRpc, rawEntry: unknown): void {
    if (!this.deps.isEnabled()) return;
    const target = this.deps.targetFor(rpc);
    // 无 target(replay / 未绑定):安全旁路 —— 解析都不做,不留任何状态。
    if (!target) return;
    const { editReply, sendLiveCard } = this.deps.seam ?? {};
    if (!editReply || !sendLiveCard) return;

    // adapter 判别:非进度条目(undefined)→ 维持现状 debug 日志路径。
    // 两段解析:先裸解析取 runId(纯函数,无副作用),再带上一份 IR 累积合并
    // —— router 不触碰快照内部字段,runId 只从 IR 读回。
    const bare = parseWorkflowProgress(rawEntry);
    if (!bare) {
      logger.debug("[agent] session entry written");
      return;
    }
    const lastIrMap = this.lastIr.get(rpc) ?? new Map<string, WorkflowProgressIR>();
    this.lastIr.set(rpc, lastIrMap);
    const ir = parseWorkflowProgress(rawEntry, lastIrMap.get(bare.runId)) ?? bare;
    lastIrMap.set(ir.runId, ir);

    const generation = this.generationOf(rpc);
    const captured = generation.capture();
    const stale = (): boolean => generation.stale(captured);
    const ledger = this.ledgers.get(rpc) ?? { cards: new Map<string, WorkflowCard>() };
    this.ledgers.set(rpc, ledger);
    this.deps.restart.once(rpc, "workflow-card", () => this.invalidate(rpc));

    const prevCard = ledger.cards.get(ir.runId);
    // finalized 卡永不复活:终态后同 runId 的迟到快照直接忽略。
    if (prevCard?.finalized) return;

    // 状态翻转 = 与上次渲染的归一状态不同(首见快照不算翻转)。
    const prevStatus = this.lastStatus.get(rpc)?.get(ir.runId);
    const statusFlipped = prevStatus !== undefined && prevStatus !== ir.status;
    const terminal = isTerminal(ir.status);

    const supersededRunId = ledger.activeRunId !== undefined && ledger.activeRunId !== ir.runId
      ? ledger.activeRunId
      : undefined;
    const supersededCard = supersededRunId !== undefined ? ledger.cards.get(supersededRunId) : undefined;
    const supersededPending = supersededCard !== undefined && !supersededCard.finalized;

    const text = renderWorkflowProgress(ir, this.deps.labels);
    const throttleMs = this.deps.throttleMs();

    // 降级中的卡:按放大间隔用最新文本重试编辑(不逐条直发)。
    if (prevCard?.degraded) {
      if (Date.now() - prevCard.lastEditAt < this.deps.degradedRetryMs) return;
      void (async () => {
        try {
          await editReply(target.chatId, target.transport, prevCard.eventId, text);
        } catch (err) {
          logger.warn(`workflow card degraded retry failed for ${target.chatId}: ${errorMessage(err)}`);
          return;
        }
        if (stale()) return;
        prevCard.text = text;
        prevCard.degraded = false;
        prevCard.lastEditAt = Date.now();
        if (terminal) prevCard.finalized = true;
      })();
      return;
    }

    // 节流:进度刷新类快照距上次编辑 < throttleMs 跳过;状态翻转与终态立即编辑。
    if (prevCard && !statusFlipped && !terminal && Date.now() - prevCard.lastEditAt < throttleMs) return;

    ledger.activeRunId = ir.runId;
    const statusMap = this.lastStatus.get(rpc) ?? new Map<string, WorkflowRunStatus>();
    statusMap.set(ir.runId, ir.status);
    this.lastStatus.set(rpc, statusMap);

    void (async () => {
      // 新 runId 且旧活跃卡非终态:先补一次「已中断,另起新卡」编辑再开新卡
      // (spec 票3:顺序约束 —— 旧卡收敛在前,新卡出站在后)。
      if (supersededPending && supersededCard) {
        supersededCard.finalized = true;
        try {
          await editReply(target.chatId, target.transport, supersededCard.eventId, `${supersededCard.text}\n\n${t("workflow.card.superseded")}`);
        } catch (err) {
          // 旧卡补编辑失败不阻塞新卡:旧卡就地定稿失败,标记降级即可。
          logger.warn(`workflow card interrupt-edit failed for ${target.chatId}: ${errorMessage(err)}`);
          supersededCard.finalized = true;
          supersededCard.degraded = true;
        }
        if (stale()) return;
      }
      if (!prevCard) {
        const eventId = await sendLiveCard(target.chatId, target.transport, text).catch(() => undefined);
        if (!eventId) {
          // 开卡失败不留状态:下一快照自然重试开卡。
          logger.debug(`workflow card: no event_id for ${target.chatId} — next snapshot retries opening one`);
          return;
        }
        if (stale()) return;
        const card: WorkflowCard = { eventId, text, finalized: terminal, degraded: false, lastEditAt: Date.now() };
        ledger.cards.set(ir.runId, card);
        return;
      }
      try {
        await editReply(target.chatId, target.transport, prevCard.eventId, text);
      } catch (err) {
        // 失败降级:保留最后一次成功 text,置 degraded,放大间隔重试。
        logger.warn(`workflow card edit failed for ${target.chatId}: ${errorMessage(err)}`);
        if (!stale()) {
          prevCard.degraded = true;
          prevCard.lastEditAt = Date.now();
        }
        return;
      }
      if (stale()) return;
      prevCard.text = text;
      prevCard.lastEditAt = Date.now();
      if (terminal) prevCard.finalized = true;
    })();
  }
}
