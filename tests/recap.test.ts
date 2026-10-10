/**
 * Session handoff cards (issue #122): card rendering, the /recap flow
 * (generating receipt → turn capture → card, busy/empty refusals), the
 * /new linkage (opt-in, card BEFORE the switch, fail-open on errors) and
 * the management-room CC in multi-project mode.
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { recapCardTitle, recapCcPrefix, recapPromptText, renderRecapCard } from "../src/rpc/recap";
import { ConfigStore } from "../src/config";
import { makeMsg, makeRouterFixture } from "./helpers";

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
