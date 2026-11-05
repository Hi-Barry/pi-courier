/**
 * Session handoff cards (issue #122): card rendering, the /recap flow
 * (generating receipt → turn capture → card, busy/empty refusals), the
 * /new linkage (opt-in, card BEFORE the switch, fail-open on errors) and
 * the management-room CC in multi-project mode.
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { RecapBusyError, RecapLedger, recapCardTitle, recapCcPrefix, recapPromptText, renderRecapCard } from "../src/rpc/recap";
import { ConfigStore } from "../src/config";
import { makeMsg, makeRouterFixture } from "./helpers";

describe("RecapLedger.startCapture 忙拒绝(审计稳定性批 票17)", () => {
  it("上一张卡未 settle 时再次 startCapture 忙拒绝,旧槽位不被覆盖(无悬案)", async () => {
    const ledger = new RecapLedger();
    const rpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    const first = ledger.startCapture(rpc); // 槽位占用中(模拟等终答)
    await expect(ledger.startCapture(rpc)).rejects.toBeInstanceOf(RecapBusyError);
    // 旧调用仍可正常结算 —— 未被覆盖成悬案
    ledger.settleCapture(rpc, { text: "总结", pendingTools: false });
    await expect(first).resolves.toBe("总结");
    // 槽位清空后可再次捕获
    const third = ledger.startCapture(rpc);
    ledger.settleCapture(rpc, { text: "再来", pendingTools: false });
    await expect(third).resolves.toBe("再来");
  });
});

describe("RecapLedger.startCapture 崩溃失效(票 fix-recap-capture-crash-invalidation)", () => {
  /** 可驱动重启生命周期的 mock rpc:onRestarted 收集 hooks(与
   *  router-queue-lost.test.ts 同款),restart() 模拟「崩溃 → respawn 成功
   *  → 生命周期触发」。 */
  const makeRestartableRpc = () => {
    const restartHooks: Array<(rpc: PiRpc) => void> = [];
    const rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      onRestarted: vi.fn((hook: (r: PiRpc) => void) => {
        restartHooks.push(hook);
        return () => {
          const index = restartHooks.indexOf(hook);
          if (index >= 0) restartHooks.splice(index, 1);
        };
      }),
    } as unknown as PiRpc;
    const restart = (): void => {
      for (const hook of [...restartHooks]) hook(rpc);
    };
    return { rpc, restart, restartHooks };
  };

  it("prompt 应答已收后子进程重启:捕获 reject、槽位清空,后续捕获不再永久忙拒", async () => {
    const ledger = new RecapLedger();
    const { rpc, restart } = makeRestartableRpc();
    const capture = ledger.startCapture(rpc);
    // prompt 应答已收(模型在跑),桥侧在等 turn_end —— 修复前此后的崩溃无人收尾
    await vi.waitFor(() => expect(rpc.prompt).toHaveBeenCalled());
    restart();
    await expect(capture).rejects.toThrow("pi process restarted; the recap capture was aborted");
    // 槽已清:再次捕获不再撞 RecapBusyError,且能正常结算
    const again = ledger.startCapture(rpc);
    ledger.settleCapture(rpc, { text: "新卡的要点", pendingTools: false });
    await expect(again).resolves.toBe("新卡的要点");
  });

  it("settle 后重启订阅一并退订:监听器不随捕获次数累积", async () => {
    const ledger = new RecapLedger();
    const { rpc, restartHooks } = makeRestartableRpc();
    const first = ledger.startCapture(rpc);
    expect(restartHooks).toHaveLength(1);
    ledger.settleCapture(rpc, { text: "第一张", pendingTools: false });
    await expect(first).resolves.toBe("第一张");
    expect(restartHooks).toHaveLength(0); // settle 撤销订阅
    const second = ledger.startCapture(rpc);
    expect(restartHooks).toHaveLength(1); // 每次捕获至多挂一个订阅
    ledger.settleCapture(rpc, { text: "第二张", pendingTools: false });
    await expect(second).resolves.toBe("第二张");
    expect(restartHooks).toHaveLength(0);
  });

  it("重启失效本身也撤销订阅:被崩溃杀掉的捕获不留监听器", async () => {
    const ledger = new RecapLedger();
    const { rpc, restart, restartHooks } = makeRestartableRpc();
    const capture = ledger.startCapture(rpc);
    await vi.waitFor(() => expect(rpc.prompt).toHaveBeenCalled());
    restart();
    await expect(capture).rejects.toThrow("restarted");
    expect(restartHooks).toHaveLength(0);
  });

  it("prompt 发送失败:捕获 reject、槽位清空,重启订阅一并退订(收尾不攒监听器)", async () => {
    const ledger = new RecapLedger();
    const offRestart = vi.fn();
    const rpc = {
      prompt: vi.fn().mockRejectedValue(new Error("send failed")),
      onRestarted: vi.fn(() => offRestart),
    } as unknown as PiRpc;
    await expect(ledger.startCapture(rpc)).rejects.toThrow("send failed");
    // 槽已清:迟到的 turn_end 不再命中
    expect(ledger.settleCapture(rpc, { text: "迟到", pendingTools: false })).toBe("none");
    expect(offRestart).toHaveBeenCalledTimes(1);
  });

  it("无 onRestarted 的旧形态 rpc:可选订阅不炸,结算路径与现状一致", async () => {
    const ledger = new RecapLedger();
    const rpc = { prompt: vi.fn().mockResolvedValue(undefined) } as unknown as PiRpc;
    const capture = ledger.startCapture(rpc);
    ledger.settleCapture(rpc, { text: "总结", pendingTools: false });
    await expect(capture).resolves.toBe("总结");
  });
});

describe("recap card rendering (issue #122)", () => {
  it("plain card: header, body, optional context line", () => {
    const card = renderRecapCard({ title: "2026-10-10 15:30", body: "- 要点一\n- 要点二", context: "12.3%/200k" });
    expect(card).toContain("📋 交接卡 · 2026-10-10 15:30");
    expect(card).toContain("- 要点一");
    expect(card).toContain("📜 上下文占用:12.3%/200k");
  });

  it("project prefix renames the header; missing context omits the line", () => {
    const card = renderRecapCard({ title: "T", body: "- b", project: "proj-a" });
    expect(card).toContain("📋 proj-a 交接卡 · T");
    expect(card).not.toContain("📜");
    expect(recapCcPrefix("proj-a")).toContain("proj-a");
  });

  it("title is local time + optional session hint", () => {
    const title = recapCardTitle("01a123a0-abcdef", new Date(2026, 9, 10, 15, 30));
    expect(title).toBe("2026-10-10 15:30 · #01a123a0");
    expect(recapCardTitle(undefined, new Date(2026, 9, 10, 9, 5))).toBe("2026-10-10 09:05");
  });

  it("the recap prompt asks for bounded bullets", () => {
    expect(recapPromptText()).toContain("5 个要点");
  });
});

/** turn_end 事件的最小 AssistantMessage 形状(文本轮,无工具调用)。 */
const turnEnd = (text: string) => ({
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
});

interface FixtureOptions {
  streaming?: boolean;
  onNew?: boolean;
  managementRooms?: string[];
  projectLabel?: string;
}

function makeFixture(options: FixtureOptions = {}) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const prompt = vi.fn().mockResolvedValue(undefined);
  const newSession = vi.fn().mockResolvedValue({ cancelled: false });
  let streaming = options.streaming ?? false;
  const rpc = {
    prompt,
    getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
    label: "proj-a",
    onEvent: vi.fn(),
    requireClient: vi.fn().mockReturnValue({
      getState: vi.fn().mockImplementation(async () => ({ isStreaming: streaming, model: { id: "m" }, sessionId: "01a123a0-xyz" })),
      newSession,
    }),
  } as unknown as PiRpc;
  const { router, projectManager } = makeRouterFixture({
    rpc,
    store: new ConfigStore({
      ...(options.onNew ? { recap: { onNew: true } } : {}),
      ...(options.managementRooms ? { managementRooms: options.managementRooms } : {}),
    }),
    sendReply: async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    },
  });
  // 本特性唯一要动的 PM 面:项目标签(labelForRoom),mock 现场改在工厂的默认 PM 上。
  (projectManager.labelForRoom as ReturnType<typeof vi.fn>).mockReturnValue(options.projectLabel);
  /** 把进程喂到「已完成 N 轮」:直接灌 N 个文本 turn_end。 */
  const seedTurns = (count: number): void => {
    for (let i = 0; i < count; i += 1) router.handleEvent(turnEnd(`第 ${i + 1} 轮回答`), rpc);
  };
  const setStreaming = (value: boolean): void => {
    streaming = value;
  };
  return { router, rpc, prompt, newSession, replies, seedTurns, setStreaming };
}

describe("/recap flow (issue #122)", () => {
  it("happy path: generating receipt → card replaces the raw answer; two-phase", async () => {
    const fixture = makeFixture();
    fixture.seedTurns(2);
    const inflight = fixture.router.handleIncoming(makeMsg({ text: "/recap" }));
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledWith(expect.stringContaining("5 个要点")));
    fixture.router.handleEvent(turnEnd("- 要点一\n- 要点二"), fixture.rpc);
    await inflight;
    // 两段式:先「生成中」,后卡片;终答文本不重复发房间
    expect(fixture.replies[0]!.text).toContain("⏳ 正在生成交接卡");
    expect(fixture.replies).toHaveLength(2);
    expect(fixture.replies[1]!.text).toContain("📋 交接卡 ·");
    expect(fixture.replies[1]!.text).toContain("- 要点一");
    expect(fixture.replies.some((r) => r.text.includes("第 1 轮回答"))).toBe(false);
  });

  it("busy process refuses /recap without prompting", async () => {
    const fixture = makeFixture({ streaming: true });
    fixture.seedTurns(3);
    await fixture.router.handleIncoming(makeMsg({ text: "/recap" }));
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.replies.at(-1)!.text).toContain("先等它完成或 /stop");
  });

  it("fewer than two completed turns → nothing to summarize", async () => {
    const fixture = makeFixture();
    await fixture.router.handleIncoming(makeMsg({ text: "/recap" }));
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.replies.at(-1)!.text).toContain("还没聊出什么");
  });

  it("intermediate tool rounds keep waiting; the final round lands the card", async () => {
    const fixture = makeFixture();
    fixture.seedTurns(2);
    const inflight = fixture.router.handleIncoming(makeMsg({ text: "/recap" }));
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalled());
    // 工具循环中间轮(pendingTools):不落卡,房间只看得到「生成中」
    fixture.router.handleEvent(
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "中间步骤" }, { type: "toolCall", id: "t1" }], stopReason: "toolUse" },
      },
      fixture.rpc
    );
    expect(fixture.replies).toHaveLength(1);
    fixture.router.handleEvent(turnEnd("- 最终要点"), fixture.rpc);
    await inflight;
    expect(fixture.replies).toHaveLength(2);
    expect(fixture.replies[1]!.text).toContain("- 最终要点");
  });
});

describe("/new linkage (issue #122)", () => {
  it("onNew on + enough turns: card lands BEFORE the switch; counter resets after", async () => {
    const fixture = makeFixture({ onNew: true });
    fixture.seedTurns(3);
    const inflight = fixture.router.handleIncoming(makeMsg({ text: "/new" }));
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalled());
    fixture.router.handleEvent(turnEnd("- 卡片要点"), fixture.rpc);
    await inflight;
    const promptOrder = fixture.prompt.mock.invocationCallOrder[0]!;
    const switchOrder = fixture.newSession.mock.invocationCallOrder[0]!;
    expect(promptOrder).toBeLessThan(switchOrder); // 先出卡,后开新
    expect(fixture.replies.some((r) => r.text.includes("📋 交接卡 ·"))).toBe(true);
    expect(fixture.replies.some((r) => r.text.includes("✅ 已开始新会话"))).toBe(true);
    // 记账归零:新会话里 /recap 属空会话拒绝
    await fixture.router.handleIncoming(makeMsg({ text: "/recap" }));
    expect(fixture.replies.at(-1)!.text).toContain("还没聊出什么");
  });

  it("onNew off (default): /new behaves exactly as before — no card, no prompt", async () => {
    const fixture = makeFixture();
    fixture.seedTurns(5);
    await fixture.router.handleIncoming(makeMsg({ text: "/new" }));
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.replies.some((r) => r.text.includes("📋"))).toBe(false);
    expect(fixture.replies.some((r) => r.text.includes("✅ 已开始新会话"))).toBe(true);
  });

  it("generation failure never blocks /new (fail-open pin)", async () => {
    const fixture = makeFixture({ onNew: true });
    fixture.prompt.mockRejectedValue(new Error("provider down"));
    fixture.seedTurns(3);
    await fixture.router.handleIncoming(makeMsg({ text: "/new" }));
    expect(fixture.newSession).toHaveBeenCalledTimes(1);
    expect(fixture.replies.some((r) => r.text.includes("✅ 已开始新会话"))).toBe(true);
  });
});

describe("management-room CC (issue #122)", () => {
  it("multi-project: the card is copied to the management room with the project prefix", async () => {
    const fixture = makeFixture({ projectLabel: "proj-a", managementRooms: ["!mgmt:server"] });
    fixture.seedTurns(2);
    const inflight = fixture.router.handleIncoming(makeMsg({ chatId: "!proj:server", text: "/recap" }));
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalled());
    fixture.router.handleEvent(turnEnd("- 要点"), fixture.rpc);
    await inflight;
    const cc = fixture.replies.find((r) => r.chatId === "!mgmt:server");
    expect(cc).toBeDefined();
    expect(cc!.text).toContain("📋 proj-a 交接卡(项目干活日志)");
    expect(cc!.text).toContain("- 要点");
    // 本房间照常拿卡
    expect(fixture.replies.some((r) => r.chatId === "!proj:server" && r.text.includes("📋 proj-a 交接卡 ·"))).toBe(true);
  });
});
