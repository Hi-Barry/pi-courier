/**
 * Model fallback chain through the router (issue #121): consecutive failed
 * turns (stopReason "error", pi auto-retry already exhausted) trip the chain —
 * one automatic setModel per threshold, room receipt + audit line, success
 * clears the streak, the chain exhausts exactly once. Project chains
 * (issue #119 fallbacks field) override the global one.
 *
 * 连败轮次按生产形态驱动:默认进程的绑定随每轮终答释放,所以每个 turn_end
 * 之前都有一条新用户消息重新绑定 —— "连续失败"天然就是"连发的消息都失败"。
 * 每轮失败/成功各产生一条原生回复;降级回执与审计在此之上断言。
 */
import { describe, expect, it, vi } from "vitest";
import { AUDIT_EVENTS } from "../src/audit/audit-log";
import { ConfigStore } from "../src/config";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { makeMsg, makeRouterFixture } from "./helpers";

const failTurn = { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "boom" }], stopReason: "error", errorMessage: "403" } };
const okTurn = { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "fine" }] } };

function makeFallbackRouter(options: {
  globalChain?: string[];
  projectChain?: string[] | undefined;
  currentModel?: { provider?: string; id?: string };
  setModelShouldThrow?: Error;
}) {
  const state = { model: options.currentModel ?? { provider: "bad", id: "m1" }, isStreaming: false };
  const setModel = vi.fn(async (provider: string, id: string) => {
    if (options.setModelShouldThrow) throw options.setModelShouldThrow;
    state.model = { provider, id };
    return { id };
  });
  // 可驱动重启生命周期的 mock rpc:收集 hooks 供 spec #335 的重启归零用例
  // 手动触发(与 router-queue-lost.test.ts 同款)。
  const restartHooks: Array<(r: PiRpc) => void> = [];
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    label: undefined,
    onEvent: vi.fn(),
    onRestarted: vi.fn((hook: (r: PiRpc) => void) => {
      restartHooks.push(hook);
      return () => {};
    }),
    requireClient: vi.fn().mockReturnValue({
      getState: vi.fn().mockImplementation(async () => ({ ...state })),
      setModel,
    }),
  } as unknown as PiRpc;
  const fixture = makeRouterFixture({
    audit: true,
    rpc,
    store: new ConfigStore(options.globalChain ? { modelFallbacks: options.globalChain } : {}),
  });
  // 本特性唯一要动的 PM 面:项目链覆盖全局链,mock 现场改在工厂的默认 PM 上。
  const projectFallbacks = fixture.projectManager.projectFallbacks as ReturnType<typeof vi.fn>;
  projectFallbacks.mockImplementation(() => options.projectChain);
  const failRound = async (): Promise<void> => {
    await fixture.router.handleIncoming(makeMsg({ text: "再试一次" }));
    fixture.router.handleEvent(failTurn, rpc);
  };
  const okRound = async (): Promise<void> => {
    await fixture.router.handleIncoming(makeMsg({ text: "再来一轮" }));
    fixture.router.handleEvent(okTurn, rpc);
  };
  // spec #335 重试序列驱动:绑定一次后连续送事件,中间不发新入站消息 ——
  // 正是「错误轮 → auto_retry_start → 重试轮 → auto_retry_end」的生产顺序。
  const bindRoom = async (chatId = "!dm:server"): Promise<void> => {
    await fixture.router.handleIncoming(makeMsg({ chatId, text: "同一条提示词" }));
  };
  const failEvent = (): void => {
    fixture.router.handleEvent(failTurn, rpc);
  };
  const retryStart = (attempt = 1, maxAttempts = 15): void => {
    fixture.router.handleEvent({ type: "auto_retry_start", attempt, maxAttempts, errorMessage: "429" }, rpc);
  };
  const retryEnd = (success = false): void => {
    fixture.router.handleEvent({ type: "auto_retry_end", success, finalError: success ? undefined : "429" }, rpc);
  };
  const settle = (): void => {
    fixture.router.handleEvent({ type: "agent_settled" }, rpc);
  };
  const restart = (): void => {
    for (const hook of [...restartHooks]) hook(rpc);
  };
  return {
    sendReply: fixture.sendReply,
    setModel,
    auditLines: fixture.auditLines,
    projectFallbacks,
    isProjectRoom: fixture.projectManager.isProjectRoom as ReturnType<typeof vi.fn>,
    failRound,
    okRound,
    bindRoom,
    failEvent,
    retryStart,
    retryEnd,
    settle,
    restart,
  };
}

describe("model fallback chain (issue #121)", () => {
  it("stays silent on a single failed turn — no switch, no receipt, no audit", async () => {
    const { sendReply, setModel, auditLines, failRound } = makeFallbackRouter({ globalChain: ["zai/glm-5.3"] });
    await failRound();
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(1)); // 失败回复照发
    expect(setModel).not.toHaveBeenCalled();
    expect(auditLines).toHaveLength(0);
  });

  it("two consecutive failures → switch along the chain, one receipt, one audit line", async () => {
    const { setModel, sendReply, auditLines, failRound } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3", "deepseek/d1"],
    });
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(auditLines).toHaveLength(1));
    expect(setModel).toHaveBeenCalledWith("zai", "glm-5.3");
    const receipts = sendReply.mock.calls.map((c) => c[2] as string);
    expect(receipts.some((text) => text.includes("zai/glm-5.3") && text.includes("bad/m1"))).toBe(true);
    expect(auditLines[0]!.event).toBe(AUDIT_EVENTS.modelFallback);
    expect(auditLines[0]!.actor).toBe("system");
    expect(auditLines[0]!.detail).toContain("bad/m1 → zai/glm-5.3");
  });

  it("a successful turn clears the streak — fail/success/fail never switches", async () => {
    const { setModel, failRound, okRound } = makeFallbackRouter({ globalChain: ["zai/glm-5.3"] });
    await failRound();
    await okRound();
    await failRound();
    await new Promise((r) => setTimeout(r, 20));
    expect(setModel).not.toHaveBeenCalled();
  });

  it("the next failure after a switch advances to the following chain entry", async () => {
    const { setModel, failRound } = makeFallbackRouter({ globalChain: ["zai/glm-5.3", "deepseek/d1"] });
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(2));
    expect(setModel).toHaveBeenLastCalledWith("deepseek", "d1");
  });

  it("chain exhausted: one notice only, never a loop — and a success re-arms it", async () => {
    const { sendReply, setModel, failRound, okRound } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
      currentModel: { provider: "zai", id: "glm-5.3" },
    });
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(3)); // 两条失败回复 + 一条耗尽提示
    expect(setModel).not.toHaveBeenCalled();
    await failRound();
    await failRound();
    await new Promise((r) => setTimeout(r, 20));
    expect(sendReply).toHaveBeenCalledTimes(5); // 只有失败回复,耗尽提示不重复
    await okRound();
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(9)); // 成功重计,耗尽提示重新武装
    const texts = sendReply.mock.calls.map((c) => c[2] as string);
    expect(texts.filter((t) => t.includes("降级链"))).toHaveLength(2);
  });

  it("no chain configured → behaviour identical to the pre-feature router", async () => {
    const { sendReply, setModel, auditLines, failRound } = makeFallbackRouter({});
    await failRound();
    await failRound();
    await failRound();
    await new Promise((r) => setTimeout(r, 20));
    expect(setModel).not.toHaveBeenCalled();
    expect(auditLines).toHaveLength(0);
    expect(sendReply).toHaveBeenCalledTimes(3); // 只有逐轮的失败回复
  });

  it("project chain overrides the global chain (issue #119 fallbacks field)", async () => {
    const { setModel, projectFallbacks, failRound } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
      projectChain: ["deepseek/d1"],
    });
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
    expect(projectFallbacks).toHaveBeenCalledWith("!dm:server");
    expect(setModel).toHaveBeenCalledWith("deepseek", "d1");
  });

  it("a failing setModel reports the failure instead of switching silently", async () => {
    const { sendReply, setModel, auditLines, failRound } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
      setModelShouldThrow: new Error("model not found"),
    });
    await failRound();
    await failRound();
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(3)); // 两条失败回复 + 一条切换失败提示
    expect(setModel).toHaveBeenCalled();
    // 出站顺序不保证(切换失败提示与失败回复并发),按内容找提示
    const texts = sendReply.mock.calls.map((c) => c[2] as string);
    expect(texts.filter((t) => t.includes("model not found"))).toHaveLength(1);
    expect(auditLines).toHaveLength(0);
  });
});

describe("auto-retry attempts do not advance the fallback streak (spec #335)", () => {
  /** 房间收到的降级回执特征(切换/切换失败/耗尽),用于断言重试期间零回执。 */
  const fallbackReceipts = (sendReply: ReturnType<typeof vi.fn>): string[] =>
    sendReply.mock.calls
      .map((c) => c[2] as string)
      .filter((text) => text.includes("已自动切换模型") || text.includes("降级链") || text.includes("自动切换到"));

  it("one prompt's retry storm never switches; the next prompt-level failure still does", async () => {
    const { sendReply, setModel, bindRoom, failEvent, retryStart, retryEnd } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3", "deepseek/d1"],
    });
    await bindRoom();
    failEvent(); // 提示词级第 1 次彻底失败 → 连败 1
    retryStart(); // pi 自动重试开始
    failEvent();
    failEvent();
    failEvent(); // 3 个重试 attempt:不计连败
    // 4 条失败回复 + 1 条重试进度回执;重试 attempt 不产生切换/耗尽回执。
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(5));
    expect(setModel).not.toHaveBeenCalled();
    expect(fallbackReceipts(sendReply)).toHaveLength(0);

    retryEnd(false); // 重试耗尽回执照发,仍不切换
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(6));
    expect(setModel).not.toHaveBeenCalled();

    // 新提示词的首个错误轮 = 提示词级第 2 次失败 → 恰好切换一次。
    await bindRoom();
    failEvent();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
    expect(setModel).toHaveBeenCalledWith("zai", "glm-5.3");
  });

  it("a pinned project room's retry attempts do not advance the streak either", async () => {
    const { sendReply, setModel, bindRoom, failEvent, retryStart, retryEnd, isProjectRoom } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
    });
    isProjectRoom.mockImplementation((roomId: string) => roomId === "!proj:server");
    await bindRoom("!proj:server");
    failEvent(); // 连败 1(pinned 绑定不释放,后续事件照常到达)
    retryStart();
    failEvent();
    failEvent(); // 重试 attempt:不计连败
    retryEnd(false);
    // 3 条失败回复 + 重试进度 + 耗尽回执;零切换。
    await vi.waitFor(() => expect(sendReply).toHaveBeenCalledTimes(5));
    expect(setModel).not.toHaveBeenCalled();

    await bindRoom("!proj:server");
    failEvent();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
  });

  it("a subprocess restart resets the retry flag and the streak", async () => {
    const { setModel, bindRoom, failEvent, retryStart, restart } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
    });
    await bindRoom();
    failEvent(); // 连败 1
    retryStart(); // 重试进行中
    failEvent(); // 被跳过
    restart(); // /reload 或崩溃拉起:标记与连败都归零
    failEvent(); // 重新从 1 开始
    await new Promise((r) => setTimeout(r, 20));
    expect(setModel).not.toHaveBeenCalled(); // 若 runs 未清,这一轮就会切换
    failEvent(); // 第 2 次 → 阈值
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
  });

  it("agent_settled clears only the retry flag — the streak survives", async () => {
    const { setModel, bindRoom, failEvent, retryStart, settle } = makeFallbackRouter({
      globalChain: ["zai/glm-5.3"],
    });
    await bindRoom();
    failEvent(); // 连败 1
    retryStart();
    failEvent(); // 被跳过
    settle(); // 异常路径兜底:只清重试标记
    failEvent(); // 第 2 次 → 阈值(若 settled 误清 runs,这里不会切换)
    await vi.waitFor(() => expect(setModel).toHaveBeenCalledTimes(1));
  });
});
