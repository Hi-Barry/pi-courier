/**
 * 工作流进度活卡全路径测试(工作流状态机票4):真实 dwf 快照 fixture
 * (tests/fixtures/dwf-progress/*.jsonl)条目本体包成 wire 事件({"type":"entry_appended","entry":{...}})喂
 * handleEvent 缝 —— adapter 归一/累积/裁剪逻辑不另设直测缝,经同一缝隙
 * 断言卡片出站文本。手法复用 router-livecard.test.ts:vi.fn 注入
 * sendLiveCard / editReply,flush 结算驱动,只断言出站调用。
 *
 * 断言以 zh 文案表(src/i18n/zh.ts,键集基准)为锚;构造快照走真实
 * JSONL 或同形状字面量,不走构造捷径。节流用例走 fake timers
 * (advanceTimersByTimeAsync 同时充当 flush —— setTimeout/微任务都在
 * fake 时钟上结算)。
 *
 * 覆盖 spec Testing Decisions ①-⑬,见各 it 标题编号。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { ConfigStore } from "../src/config";
import type { MessageRouterDeps } from "../src/rpc/message-router";
import { makeFakeRpc, makeMsg, makeRouterFixture } from "./helpers";
import type { PiRpc } from "../src/rpc/pi-rpc";

const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
};

/** 读真机 fixture 的原始行(逐行 JSON.parse,直接可喂 handleEvent)。 */
function loadFixture(name: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(new URL(`fixtures/dwf-progress/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const twoPhase = (): Array<Record<string, unknown>> => loadFixture("two-phase-completed");
const tenPhase = (): Array<Record<string, unknown>> => loadFixture("ten-phase-pause-resume-stop");

/** 条目本体包成 wire 事件(真机形状:{"type":"entry_appended","entry":{...}})。 */
function wire(entry: unknown): unknown {
  return { type: "entry_appended", entry };
}

/** 与 fixture 同形状的字面量条目(不走构造捷径:customType 顶层 + data 内层)。 */
function dwfEvent(runId: string, status: string, extra: Record<string, unknown> = {}): unknown {
  return wire({
    type: "custom",
    customType: "pi-dynamic-workflows:progress",
    data: { version: 1, runId, name: "wf", status, agents: [], ...extra },
  });
}

/** fixture 行换 runId(其余原样 —— 走真实快照形状)。 */
function withRunId(row: Record<string, unknown>, runId: string): unknown {
  return { ...row, data: { ...(row.data as Record<string, unknown>), runId } };
}

interface WfFixture {
  router: ReturnType<typeof makeRouterFixture>["router"];
  rpc: PiRpc;
  editReply: ReturnType<typeof vi.fn>;
  sendLiveCard: ReturnType<typeof vi.fn>;
}

async function makeWfFixture(storeOpts: Record<string, unknown> = {}, withDeps = true): Promise<WfFixture> {
  let cardSeq = 0;
  const editReply = vi.fn(withDeps ? (async () => {}) : undefined);
  const sendLiveCard = vi.fn(withDeps ? (async () => `$card-${(cardSeq += 1)}`) : undefined);
  const { router, rpc } = makeRouterFixture({
    rpc: makeFakeRpc(),
    store: new ConfigStore(storeOpts),
    // withDeps=false 时干脆不注入这两个键(deps 里真缺省),而非注入空实现
    // —— 旁路检查的是「deps 缺失」,不是「调用返回空」。
    extra: (withDeps ? { editReply, sendLiveCard } : {}) as Partial<MessageRouterDeps>,
  });
  // 建立绑定:回复目标 = 默认 DM(makeMsg 的 !dm:server)。
  await router.handleIncoming(makeMsg({ text: "do work" }));
  return { router, rpc, editReply, sendLiveCard };
}

/** fake-timer 结算:推时钟并结算微任务(等于真实 flush)。 */
const tick = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("工作流进度活卡(真机 fixture 喂 handleEvent 缝)", () => {
  it("① 首快照开卡:sendLiveCard 收到渲染文本,标题含工作流名", async () => {
    const fx = await makeWfFixture();
    fx.router.handleEvent(wire(twoPhase()[0]), fx.rpc);
    await flush();
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    const text = fx.sendLiveCard.mock.calls[0][2] as string;
    expect(text).toContain("two_phase_files"); // IR.name 来自快照
    expect(text).toContain("▶️"); // zh 表 workflow.icon.running
    expect(text).toContain("💡 可直接用自然语言操控工作流"); // 尾注 zh 表锚
  });

  it("② 后续快照节流:间隔内不编辑,超过间隔正常编辑", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    fx.router.handleEvent(wire(twoPhase()[0]), fx.rpc);
    await tick(0);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    fx.editReply.mockClear();

    // 1 秒后的进度快照:节流跳过
    await tick(1000);
    fx.router.handleEvent(wire(twoPhase()[1]), fx.rpc);
    await tick(0);
    expect(fx.editReply).not.toHaveBeenCalled();

    // 再推 3 秒(累计 > 节流间隔):正常编辑
    await tick(3000);
    fx.router.handleEvent(wire(twoPhase()[1]), fx.rpc);
    await tick(0);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
  });

  it("③ 终态定格:completed 落卡 finalized,后续同 runId 快照不再编辑", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    const rows = twoPhase();
    let clock = 0;
    for (const ev of rows) {
      clock += 4000; // 逐条跨过节流间隔,每条都结算
      await tick(clock);
      fx.router.handleEvent(wire(ev), fx.rpc);
      await tick(0);
    }
    expect(fx.editReply).toHaveBeenCalled();
    expect(fx.editReply.mock.calls.at(-1)![3] as string).toContain("✅");
    const edits = fx.editReply.mock.calls.length;
    // 终态后再来同 runId 快照:零编辑
    clock += 4000;
    await tick(clock);
    fx.router.handleEvent(wire(rows[4]), fx.rpc);
    await tick(0);
    expect(fx.editReply).toHaveBeenCalledTimes(edits);
  });

  it("④ 状态翻转立即编辑:running→paused 绕过节流", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    fx.router.handleEvent(dwfEvent("r1", "running"), fx.rpc);
    await tick(0);
    fx.editReply.mockClear();
    // 100ms 后状态翻转:节流不适用
    await tick(100);
    fx.router.handleEvent(dwfEvent("r1", "paused"), fx.rpc);
    await tick(0);
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0][3] as string).toContain("⏸"); // zh 表 workflow.icon.paused
  });

  it("⑤ 新 runId 换卡:旧卡补「已中断」编辑且永不再被编辑", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    const rows = twoPhase();
    fx.router.handleEvent(wire(rows[0]), fx.rpc);
    await tick(0);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    fx.editReply.mockClear();
    fx.sendLiveCard.mockClear();

    fx.router.handleEvent(wire(withRunId(rows[0], "brand-new-run")), fx.rpc);
    await tick(0);
    // 旧卡补一次中断编辑(zh 表 workflow.card.superseded)
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.editReply.mock.calls[0][3] as string).toContain("⚠️ 上一个工作流已中断");
    // 新卡另开
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);

    // 旧卡永不复活:再来旧 runId 的快照零编辑、零开卡
    fx.editReply.mockClear();
    fx.sendLiveCard.mockClear();
    await tick(4000);
    fx.router.handleEvent(wire(rows[0]), fx.rpc);
    await tick(0);
    expect(fx.editReply).not.toHaveBeenCalled();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
  });

  it("⑥ 非 progress 的 entry_appended 旁路:零出站调用", async () => {
    const fx = await makeWfFixture();
    fx.router.handleEvent({ type: "entry_appended", entry: { type: "custom", customType: "other:thing", data: { version: 1 } } }, fx.rpc);
    fx.router.handleEvent({ type: "entry_appended" }, fx.rpc);
    await flush();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
    expect(fx.editReply).not.toHaveBeenCalled();
  });

  it("⑦ 开关关闭旁路:workflowProgressCard=false 零出站", async () => {
    const fx = await makeWfFixture({ workflowProgressCard: false });
    for (const ev of twoPhase()) fx.router.handleEvent(wire(ev), fx.rpc);
    await flush();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
    expect(fx.editReply).not.toHaveBeenCalled();
  });

  it("⑧ 缺省出站依赖旁路:未注入 sendLiveCard/editReply 零出站", async () => {
    const fx = await makeWfFixture({}, false);
    for (const ev of twoPhase()) fx.router.handleEvent(wire(ev), fx.rpc);
    await flush();
    expect(fx.sendLiveCard).not.toHaveBeenCalled();
    expect(fx.editReply).not.toHaveBeenCalled();
  });

  it("⑨ 编辑失败保状态 + 30 秒放大间隔重试(不逐条直发)", async () => {
    vi.useFakeTimers();
    const editReply = vi.fn(async () => {
      throw new Error("edit boom");
    });
    const sendLiveCard = vi.fn(async () => "$card-1");
    const { router, rpc } = makeRouterFixture({
      rpc: makeFakeRpc(),
      store: new ConfigStore({}),
      extra: { editReply, sendLiveCard } as Partial<MessageRouterDeps>,
    });
    await router.handleIncoming(makeMsg({ text: "do work" }));

    router.handleEvent(dwfEvent("r1", "running"), rpc);
    await tick(0);
    expect(sendLiveCard).toHaveBeenCalledTimes(1);

    // 快照到达触发编辑 → 失败置 degraded
    await tick(4000);
    router.handleEvent(dwfEvent("r1", "running"), rpc);
    await tick(0);
    expect(editReply).toHaveBeenCalledTimes(1);

    // 放大间隔(30 秒)内:重试被节流
    await tick(10_000);
    router.handleEvent(dwfEvent("r1", "running"), rpc);
    await tick(0);
    expect(editReply).toHaveBeenCalledTimes(1);

    // 30 秒后:重试发生(仍失败但不放弃;sendReply 不增 = 不逐条直发)
    await tick(30_000);
    router.handleEvent(dwfEvent("r1", "running"), rpc);
    await tick(0);
    expect(editReply).toHaveBeenCalledTimes(2);
    expect(sendLiveCard).toHaveBeenCalledTimes(1);
  });

  it("⑩ 子代理表格裁剪:ten-phase 真机快照,完成行折叠为计数", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    let clock = 0;
    for (const ev of tenPhase()) {
      clock += 4000;
      await tick(clock);
      fx.router.handleEvent(wire(ev), fx.rpc);
      await tick(0);
    }
    const finalText = fx.editReply.mock.calls.at(-1)![3] as string;
    const dataRows = finalText.split("\n").filter((l) => l.startsWith("| ") && !l.includes("子任务") && !l.startsWith("|---"));
    expect(dataRows.length).toBeLessThanOrEqual(4); // RECENT_DONE_KEEP=4
    expect(finalText).toContain("另有"); // zh 表 workflow.agent.collapsed
  });

  it("⑪ 多 rpc(多房间)互不串扰:各自开卡、各自终态", async () => {
    const makeRoom = async (): Promise<WfFixture> => makeWfFixture();
    const roomA = await makeRoom();
    const roomB = await makeRoom();

    roomA.router.handleEvent(wire(twoPhase()[0]), roomA.rpc);
    await flush();
    expect(roomA.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(roomB.sendLiveCard).not.toHaveBeenCalled();

    // B 跑同 runId:独立账本,B 独立开卡,A 不受影响
    roomB.router.handleEvent(wire(twoPhase()[0]), roomB.rpc);
    await flush();
    expect(roomB.sendLiveCard).toHaveBeenCalledTimes(1);
    expect(roomA.sendLiveCard).toHaveBeenCalledTimes(1);

    // A 收终态:只 A 编辑,B 不动
    vi.useFakeTimers();
    await tick(4000);
    roomA.router.handleEvent(wire(twoPhase()[4]), roomA.rpc);
    await tick(0);
    expect(roomA.editReply).toHaveBeenCalledTimes(1);
    expect(roomB.editReply).not.toHaveBeenCalled();
  });

  it("⑫ 被跳过子代理显示「跳过」(ten-phase fixture 的 skipped 状态)", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    let clock = 0;
    for (const ev of tenPhase()) {
      clock += 4000;
      await tick(clock);
      fx.router.handleEvent(wire(ev), fx.rpc);
      await tick(0);
    }
    const texts = [
      fx.sendLiveCard.mock.calls[0][2] as string,
      ...fx.editReply.mock.calls.map((c) => c[3] as string),
    ];
    // 行 9 的 skipped 子代理(P3 agent 3)进入过表格;zh 表 workflow.agentStatus.skipped
    expect(texts.some((t) => t.includes("| P3 agent 3 | P3 | 跳过 |"))).toBe(true);
  });

  it("⑬ agent_start 不清工作流卡:与既有活卡隔离的旁路回归", async () => {
    vi.useFakeTimers();
    const fx = await makeWfFixture();
    fx.router.handleEvent(dwfEvent("r1", "running"), fx.rpc);
    await tick(0);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
    fx.editReply.mockClear();

    // 轮次边界:agent_start 只清工具循环活卡,工作流卡不受影响
    fx.router.handleEvent({ type: "agent_start" }, fx.rpc);
    await tick(4000);
    fx.router.handleEvent(dwfEvent("r1", "running", { tokens: 999, agents: [{ id: 1, label: "Alpha agent 1", status: "running", phase: "Alpha" }] }), fx.rpc);
    await tick(0);
    // 工作流卡仍在:编辑照常发生(若账本被清,这里会重新开卡)
    expect(fx.editReply).toHaveBeenCalledTimes(1);
    expect(fx.sendLiveCard).toHaveBeenCalledTimes(1);
  });
});
