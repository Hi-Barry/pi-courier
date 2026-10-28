/**
 * 活卡状态机主路径(issue #235 票2;内容契约修订 spec #248):工具循环中间
 * 回合聚合进同一张持续刷新的卡片 —— 卡片只装工具行,旁白文本独立成卡并
 * 断开聚合链(spec #248:旧卡定稿 → 旁白直发 → 工具行开新卡)。首回合经
 * sendLiveCard 开卡取 event_id,后续中间回合经 editReply 对同一事件就地
 * 编辑追加(回合间空行连接);终答回合照旧独立新消息并清活卡;agent_start
 * 轮次边界清卡;交接卡捕获回合不进卡、终答被捕获一并清卡;hideToolCalls /
 * 配置关 / 缺省 deps 全部旁路退回逐条。
 *
 * 只断言房间可见行为(出站调用记录:sendLiveCard / editReply / sendReply
 * 收到了什么),不断言内部状态字段。缺省 deps 回归底线由既有全部测试零
 * 改动全绿证明,这里另有显式直发一例。
 */
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ConfigStore } from "../src/config";
import type { MessageRouterDeps } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { makeFakeRpc, makeMsg, makeRouterFixture } from "./helpers";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 单条工具调用行(formatToolCalls 产出,arguments 取 50 截断前的短形)。
 *  卡片内容契约(spec #248):活卡里只有工具行,旁白永远不进卡。 */
const TOOL_LINE = "🔧 `bash` (cmd=ls)";

/** N 条工具行的回合拼装(行间单换行)—— 溢出用例的长度配方:旁白会断链,
 *  堆长度只能靠多条工具调用。 */
const toolBlock = (n: number) => Array.from({ length: n }, () => TOOL_LINE).join("\n");

/** 中间轮:旁白文本(可选)+ 工具调用(hasToolCalls → pendingTools=true)。
 *  calls 控制工具调用条数(溢出用例靠它堆长度)。 */
function toolTurn(text?: string, calls = 1): AssistantMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text !== undefined) content.push({ type: "text", text });
  for (let i = 0; i < calls; i += 1) {
    content.push({ type: "toolCall", name: "bash", arguments: { cmd: "ls" } });
  }
  return { role: "assistant", content, stopReason: "stop" } as unknown as AssistantMessage;
}

/** 纯文本收敛轮(无工具调用,pendingTools=false)。 */
function finalTurn(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as unknown as AssistantMessage;
}

type EditReplyFn = NonNullable<MessageRouterDeps["editReply"]>;
type SendLiveCardFn = NonNullable<MessageRouterDeps["sendLiveCard"]>;

interface LiveCardFixture {
  router: ReturnType<typeof makeRouterFixture>["router"];
  rpc: PiRpc;
  replies: string[];
  /** 房间可见出站的统一时序记录(reply:/open:/edit: 前缀),供顺序断言。 */
  order: string[];
  editReply: ReturnType<typeof vi.fn>;
  sendLiveCard: ReturnType<typeof vi.fn>;
}

async function makeLiveCardFixture(
  storeOpts: Record<string, unknown> = {},
  overrides: {
    editReply?: MessageRouterDeps["editReply"];
    sendLiveCard?: MessageRouterDeps["sendLiveCard"];
  } = {}
): Promise<LiveCardFixture> {
  const replies: string[] = [];
  const order: string[] = [];
  let cardSeq = 0;
  const editReplyRaw = overrides.editReply ?? (async () => {});
  const sendLiveCardRaw = overrides.sendLiveCard ?? (async () => `$card-${(cardSeq += 1)}`);
  const editReply = vi.fn(async (...args: Parameters<EditReplyFn>) => {
    order.push(`edit:${args[2]}`);
    await editReplyRaw(...args);
  });
  const sendLiveCard = vi.fn(async (...args: Parameters<SendLiveCardFn>) => {
    const eventId = await sendLiveCardRaw(...args);
    order.push(`open:${eventId ?? "none"}`);
    return eventId;
  });
  const { router, rpc } = makeRouterFixture({
    rpc: makeFakeRpc(),
    store: new ConfigStore(storeOpts),
    sendReply: async (_chatId: string, _transport: string, text: string) => {
      replies.push(text);
      order.push(`reply:${text.slice(0, 8)}`);
    },
    extra: { editReply, sendLiveCard } as Partial<MessageRouterDeps>,
  });
  // 建立绑定:回复目标 = 默认 DM(makeMsg 的 !dm:server)。
  await router.handleIncoming(makeMsg({ text: "do work" }));
  return { router, rpc, replies, order, editReply, sendLiveCard };
}

describe("活卡聚合主路径(issue #235 票2)", () => {
  it("首回合开新卡 → 中间回合编辑追加 → 终答直发并清活卡(下一循环开新卡)", async () => {
    const fx = await makeLiveCardFixture();

    // 中间轮 1:无活卡 → 开新卡,内容 = 工具行(旁白缺省,卡里只有工具行)
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard.mock.calls[0]).toEqual(["!dm:server", "matrix", TOOL_LINE]);
    expect(fx.editReply).not.toHaveBeenCalled();
    expect(fx.replies).toEqual([]); // 中间回合不再产生新消息

    // 中间轮 2:对同一事件就地编辑追加,回合间空行连接
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]).toEqual([
      "!dm:server",
      "matrix",
      "$card-1",
      `${TOOL_LINE}\n\n${TOOL_LINE}`,
    ]);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1); // 不开第二张卡

    // 中间轮 3:继续在同一张卡上累积
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(2);
    expect(fx.editReply.mock.calls[1]).toEqual([
      "!dm:server",
      "matrix",
      "$card-1",
      `${TOOL_LINE}\n\n${TOOL_LINE}\n\n${TOOL_LINE}`,
    ]);
    expect(fx.replies).toEqual([]);

    // 终答:独立新消息直发(含状态脚注路径),活卡清空
    fx.router.handleEvent({ type: "turn_end", message: finalTurn("最终答案") }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toContain("最终答案");
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.editReply).toHaveBeenCalledTimes(2);

    // 清卡生效:下一个工具循环的中间轮开新卡,而不是编辑旧卡。
    // (终答已释放默认进程的 unpinned 绑定 —— 现状语义;新一轮对话以用户
    // 新消息重建绑定,此处照实驱动。)
    await fx.router.handleIncoming(makeMsg({ text: "again" }));
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.editReply).toHaveBeenCalledTimes(2);
    expect(fx.sendLiveCard.mock.calls[1]).toEqual(["!dm:server", "matrix", TOOL_LINE]);
  });

  it("无内容回合(text=null)不动活卡:不刷新也不清卡", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // aborted 空轮(text=null):不触发任何卡片刷新
    fx.router.handleEvent(
      { type: "turn_end", message: { role: "assistant", content: [], stopReason: "aborted" } as unknown as AssistantMessage },
      fx.rpc
    );
    await flush();
    expect(fx.editReply).not.toHaveBeenCalled();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 活卡仍在:下一个有内容中间轮继续编辑原卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]![2]).toBe("$card-1");
  });

  it("agent_start 轮次边界清活卡:新一轮对话永远开新卡", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    fx.router.handleEvent({ type: "agent_start" }, fx.rpc);

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    // 新对话开新卡:绝不把新回合追加进上一轮对话的旧卡
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.editReply).not.toHaveBeenCalled();
  });

  it("交接卡捕获:中间轮捕获不进活卡不产生房间消息;终答捕获一并清活卡", async () => {
    const fx = await makeLiveCardFixture();

    // 工具循环跑两个中间轮(count 达 RECAP_MIN_TURNS),卡已活
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.editReply).toHaveBeenCalledTimes(1);

    // /recap:捕获在途(不 await —— 命令处理要等终答结算,照 recap 测试先例;
    // waitFor「prompt 收到总结指令」= startCapture 槽位已同步置位。不能等
    // prompt 被调:首个 DM 的 prompt 阶段早于 /recap 管线就满足那个条件)
    const inflight = fx.router.handleIncoming(makeMsg({ text: "/recap" }));
    await vi.waitFor(() => expect(fx.rpc.prompt).toHaveBeenCalledWith(expect.stringContaining("5 个要点")));

    // 中间轮被捕获("wait"):不进活卡;房间只有 /recap 的「生成中」回执
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toContain("正在生成交接卡");

    // 终答被捕获("settled"):卡片投递替代原生回复,活卡一并清空 ——
    // 房间恰好两条:⏳ 回执 + 交接卡(终答文本作为卡片 body,不再是独立新消息)
    fx.router.handleEvent({ type: "turn_end", message: finalTurn("总结终答") }, fx.rpc);
    await inflight;
    await flush();
    expect(fx.replies).toHaveLength(2);
    expect(fx.replies[1]).toContain("交接卡");
    expect(fx.replies[1]).toContain("总结终答");

    // 清卡生效:下一工具循环的中间轮开新卡,而非编辑被捕获序列的旧卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
  });

  it("编辑抛错:清活卡置降级,本回合补发,同轮后续回合逐条直发,agent_start 重置重新聚合", async () => {
    const fx = await makeLiveCardFixture({}, {
      editReply: vi.fn().mockRejectedValueOnce(new Error("M_LIMIT_EXCEEDED")),
    });

    // 轮 1:正常开卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 轮 2:编辑抛错(不分类不重试)→ 活卡清空 + 降级,本回合工具行直发补上
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush(); // reject 被吞,无 unhandled rejection
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.replies).toEqual([TOOL_LINE]);

    // 轮 3:同轮后续中间回合全部逐条直发(旧行为),不再碰编辑缝
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.replies).toEqual([TOOL_LINE, TOOL_LINE]);

    // 下一轮对话开始:agent_start 重置降级,重新尝试聚合(开新卡)
    fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.sendLiveCard.mock.calls[1]).toEqual(["!dm:server", "matrix", TOOL_LINE]);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
  });

  it("溢出滚动(新回合文本不超限):旧卡定稿、整体开新卡,旧卡不再被编辑", async () => {
    const fx = await makeLiveCardFixture({});

    // 轮 1:开卡,250 条工具行 ≈ 4.7k 字符(>4000,开卡直传不分片)
    fx.router.handleEvent({ type: "turn_end", message: toolTurn(undefined, 250) }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard.mock.calls[0]![2]).toBe(toolBlock(250));

    // 轮 2:「累积 + 新回合工具行」超 4000,新回合文本本身 ≤4000(单片)
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    // 旧卡收到最后一次「定稿」编辑,内容 = 既有累积(不含新回合文本)
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]![2]).toBe("$card-1");
    expect(fx.editReply.mock.calls[0]![3]).toBe(toolBlock(250));
    expect(fx.replies).toEqual([]); // 无直发片
    // 唯一片开新卡作新活卡
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.sendLiveCard.mock.calls[1]![2]).toBe(TOOL_LINE);

    // 只有最新一张卡可被编辑:后续中间回合编辑 $card-2,旧卡 event_id 不再出现
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(2);
    expect(fx.editReply.mock.calls[1]![2]).toBe("$card-2");
    expect(fx.editReply.mock.calls[1]![3]).toBe(`${TOOL_LINE}\n\n${TOOL_LINE}`);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
  });

  it("溢出滚动(新回合文本超限):定稿后前 n-1 片普通直发、最后一片开新卡,内容不丢", async () => {
    const fx = await makeLiveCardFixture({});

    fx.router.handleEvent({ type: "turn_end", message: toolTurn(undefined, 250) }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 轮 2:新回合文本本身超 4000 → 按现行拆分口径切成 3 片(按行切)
    fx.router.handleEvent({ type: "turn_end", message: toolTurn(undefined, 500) }, fx.rpc);
    await flush();
    // 旧卡定稿
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]![2]).toBe("$card-1");
    expect(fx.editReply.mock.calls[0]![3]).toBe(toolBlock(250));
    // 前 n-1 片普通新消息直发
    expect(fx.replies).toHaveLength(2);
    // 最后一片开新卡作新活卡
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    // 内容不丢:三片按序以换行重接 = 原文全文(切分吃掉的换行由重接补回)
    const rejoined = [fx.replies[0], fx.replies[1], fx.sendLiveCard.mock.calls[1]![2]].join("\n");
    expect(rejoined).toBe(toolBlock(500));
  });

  it("溢出时定稿编辑失败:全部切片逐条直发补上,不开新卡并转入降级", async () => {
    const fx = await makeLiveCardFixture({}, {
      editReply: vi.fn().mockRejectedValueOnce(new Error("M_LIMIT_EXCEEDED")),
    });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn(undefined, 250) }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 轮 2 溢出,定稿编辑抛错 → 本回合全部切片直发(单片 = 1 条),不开新卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1); // 只有失败的那次定稿尝试
    expect(fx.replies).toEqual([TOOL_LINE]);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1); // 不开新卡

    // 已入降级:下一中间回合仍逐条直发
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.replies).toEqual([TOOL_LINE, TOOL_LINE]);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
  });

  it("发新卡拿不到 event_id:仅记日志不进活卡,下一中间回合重试开卡", async () => {
    const fx = await makeLiveCardFixture({}, { sendLiveCard: vi.fn().mockResolvedValue(undefined) });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.editReply).not.toHaveBeenCalled();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    // 未进活卡状态:重试开卡而非编辑
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.editReply).not.toHaveBeenCalled();
  });
});

describe("旁白断链(spec #248)", () => {
  it("带旁白的中间回合:旁白独立直发,卡片只装工具行;后续无旁白回合照常追加", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn("我先看一下配置") }, fx.rpc);
    await flush();
    // 旁白走普通直发,工具行开卡,两者不混装
    expect(fx.replies).toEqual(["我先看一下配置"]);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard.mock.calls[0]).toEqual(["!dm:server", "matrix", TOOL_LINE]);
    expect(fx.editReply).not.toHaveBeenCalled();

    // 无旁白的下一回合:照常追加进同一张卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]).toEqual([
      "!dm:server",
      "matrix",
      "$card-1",
      `${TOOL_LINE}\n\n${TOOL_LINE}`,
    ]);
  });

  it("已有活卡时遇旁白断链:旧卡零新增编辑,旁白直发后工具行开新卡,后续追加进新卡", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 带旁白回合:旧卡($card-1)不接追加,旁白独立直发,新卡开卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn("旁白中断") }, fx.rpc);
    await flush();
    expect(fx.editReply).not.toHaveBeenCalled(); // 旧卡零编辑
    expect(fx.replies).toEqual(["旁白中断"]);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.sendLiveCard.mock.calls[1]).toEqual(["!dm:server", "matrix", TOOL_LINE]);

    // 后续无旁白回合追加进新卡,旧卡 event_id 不再出现
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0]![2]).toBe("$card-2");
  });

  it("房间顺序由架构保证:旁白先落房间,新卡后开", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn("先说一句") }, fx.rpc);
    await flush();
    expect(fx.order).toEqual(["reply:先说一句", "open:$card-1"]);
  });

  it("报错回合绕过聚合:失败行带全部内容直发,不进活卡", async () => {
    const fx = await makeLiveCardFixture();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    const errTurn = {
      role: "assistant",
      content: [
        { type: "text", text: "坏了" },
        { type: "toolCall", name: "bash", arguments: { cmd: "ls" } },
      ],
      stopReason: "error",
      errorMessage: "rate limited",
    } as unknown as AssistantMessage;
    fx.router.handleEvent({ type: "turn_end", message: errTurn }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toContain("坏了");
    expect(fx.replies[0]).toContain("❌ 本轮失败: rate limited");
    expect(fx.replies[0]).toContain("bash");
    expect(fx.editReply).not.toHaveBeenCalled();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
  });

  it("降级序列遇旁白断链:降级标志随清卡解除,新卡恢复聚合", async () => {
    const fx = await makeLiveCardFixture({}, {
      editReply: vi.fn().mockRejectedValueOnce(new Error("M_LIMIT_EXCEEDED")),
    });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    // 轮 2 编辑失败 → 降级,本回合工具行逐条直发
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.replies).toEqual([TOOL_LINE]);

    // 带旁白回合断链:降级随 clearLiveCard 一并解除,开新卡重试聚合
    fx.router.handleEvent({ type: "turn_end", message: toolTurn("换个姿势") }, fx.rpc);
    await flush();
    expect(fx.replies).toEqual([TOOL_LINE, "换个姿势"]);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.sendLiveCard.mock.calls[1]).toEqual(["!dm:server", "matrix", TOOL_LINE]);

    // 恢复聚合:下一回合编辑追加进新卡
    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(2); // 1 次失败 + 1 次新卡成功
    expect(fx.editReply.mock.calls[1]![2]).toBe("$card-2");
  });
});

describe("边界加固(spec #242)", () => {
  it("溢出滚动开新卡失败:定稿旧卡不再被编辑,下一中间回合重试开新卡(失败即不留状态)", async () => {
    let open = 0;
    const fx = await makeLiveCardFixture({}, {
      sendLiveCard: vi.fn(async () => {
        open += 1;
        return open === 2 ? undefined : `$card-${open}`; // 第 2 次(滚动开卡)失败
      }),
    });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn(undefined, 250) }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.editReply).toHaveBeenCalledTimes(1); // 只有那次定稿
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.replies).toEqual([]); // 单片全留给开卡,无直发

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(3);
    expect(fx.editReply).toHaveBeenCalledTimes(1); // 旧卡零新增编辑
    expect(fx.sendLiveCard.mock.calls[2]).toEqual(["!dm:server", "matrix", TOOL_LINE]);
  });

  it("开卡在途跨越 agent_start 清卡:迟到结果不写回,下一回合按新对话重开卡", async () => {
    let release!: (id: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    let call = 0;
    const fx = await makeLiveCardFixture({}, {
      sendLiveCard: vi.fn(async () => {
        call += 1;
        if (call === 1) return pending; // 首卡挂起在途
        return `$card-${call}`;
      }),
    });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1); // 在途挂起中

    fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
    release("$card-1");
    await flush();

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
    expect(fx.editReply).not.toHaveBeenCalled();
  });

  it("编辑在途失败跨越 agent_start:降级标志不写回新对话,失败回合文本照旧补发", async () => {
    let fail!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    const fx = await makeLiveCardFixture({}, {
      editReply: vi.fn(() => pending),
    });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
    fail(new Error("network gone"));
    await flush();
    expect(fx.replies).toEqual([TOOL_LINE]);

    fx.router.handleEvent({ type: "turn_end", message: toolTurn() }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(2);
  });
});

describe("聚合旁路(缺省 = 现状逐字节一致)", () => {
  it("hideToolCalls=true 聚合整体旁路:中间回合维持现状直发", async () => {
    const fx = await makeLiveCardFixture({ hideToolCalls: true });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn("第一步") }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
    expect(fx.editReply).not.toHaveBeenCalled();
    // 现状路径:文本直发(hideToolCalls 下工具行不进 text)
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toBe("第一步");
  });

  it("配置 aggregateToolTurns=false 完全旁路:退回逐条旧行为", async () => {
    const fx = await makeLiveCardFixture({ aggregateToolTurns: false });

    fx.router.handleEvent({ type: "turn_end", message: toolTurn("第一步") }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
    expect(fx.editReply).not.toHaveBeenCalled();
    expect(fx.replies).toHaveLength(1); // 逐条直发(含工具行的完整拼装)
    expect(fx.replies[0]).toContain("第一步");
    expect(fx.replies[0]).toContain("bash");
  });

  it("缺省 deps(未注入编辑缝)聚合禁用:中间回合逐条直发", async () => {
    const replies: string[] = [];
    const { router, rpc } = makeRouterFixture({
      rpc: makeFakeRpc(),
      sendReply: async (_c: string, _t: string, text: string) => {
        replies.push(text);
      },
    });
    await router.handleIncoming(makeMsg({ text: "do work" }));

    router.handleEvent({ type: "turn_end", message: toolTurn("第一步") }, rpc);
    router.handleEvent({ type: "turn_end", message: toolTurn("第二步") }, rpc);
    await flush();
    expect(replies).toHaveLength(2);
    expect(replies[0]).toContain("第一步");
    expect(replies[1]).toContain("第二步");
  });

  it("工具调用参数上限走配置:toolCallArgLimit 归一后进入卡片文本", async () => {
    const fx = await makeLiveCardFixture({ toolCallArgLimit: 30 });
    const longTurn = {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", arguments: { command: "q".repeat(200) } }],
      stopReason: "stop",
    } as unknown as AssistantMessage;

    fx.router.handleEvent({ type: "turn_end", message: longTurn }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    const cardText = fx.sendLiveCard.mock.calls[0]![2] as string;
    // 30 chars: 27 q's + "..."
    expect(cardText).toContain("command=" + "q".repeat(27) + "...");
    expect(cardText).not.toContain("q".repeat(28));
  });
});
