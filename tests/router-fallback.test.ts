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
import { AUDIT_EVENTS, type AuditEntry } from "../src/audit/audit-log";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import { createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

function makeMsg(overrides: Partial<ExternalMessage> & { text?: string } = {}): ExternalMessage {
  const { text = "hi", ...rest } = overrides;
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    payload: { kind: "text", text },
    isGroupChat: false,
    wasMentioned: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    ...rest,
  };
}

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
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    label: undefined,
    onEvent: vi.fn(),
    onRestarted: vi.fn().mockReturnValue(() => {}),
    requireClient: vi.fn().mockReturnValue({
      getState: vi.fn().mockImplementation(async () => ({ ...state })),
      setModel,
    }),
  } as unknown as PiRpc;
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: false,
    allRpcs: vi.fn().mockReturnValue([rpc]),
    roomForRpc: vi.fn().mockReturnValue(undefined),
    projectFallbacks: vi.fn().mockReturnValue(options.projectChain),
  } as unknown as ProjectManager;
  const store = new ConfigStore(options.globalChain ? { modelFallbacks: options.globalChain } : {});
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
  const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const sendReply = vi.fn().mockResolvedValue(undefined);
  const auditLines: AuditEntry[] = [];
  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply,
    sendTyping: vi.fn(),
    roomOps,
    store,
    pmctl,
    audit: {
      append: (event: string, actor: string, chatId: string, detail?: string) =>
        auditLines.push({ ts: Date.now(), event, actor, chatId, detail }),
    } as never,
  });
  const failRound = async (): Promise<void> => {
    await router.handleIncoming(makeMsg({ text: "再试一次" }));
    router.handleEvent(failTurn, rpc);
  };
  const okRound = async (): Promise<void> => {
    await router.handleIncoming(makeMsg({ text: "再来一轮" }));
    router.handleEvent(okTurn, rpc);
  };
  return { router, rpc, sendReply, setModel, auditLines, projectFallbacks: projectManager.projectFallbacks as ReturnType<typeof vi.fn>, failRound, okRound };
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
