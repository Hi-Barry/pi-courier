/**
 * 非自愿队列丢失回执(issue #115 阶段1)through the router: REAL
 * RpcTransientState + REAL restart lifecycle — the queue mirror is fed by
 * queue_update events (the same path production uses), the restart is fired
 * through PiRpc.onRestarted, and only the transport/rpc boundaries are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    messageId: "m1",
    timestamp: new Date(),
    ...rest,
  };
}

describe("queue lost notice on subprocess restart (issue #115 stage 1)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let restartHooks: Array<(rpc: PiRpc) => void>;
  let rpc: PiRpc;
  let router: ReturnType<typeof createMessageRouter>;

  beforeEach(() => {
    replies = [];
    restartHooks = [];
    rpc = {
      prompt: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
      onRestarted: vi.fn((hook: (rpc: PiRpc) => void) => {
        restartHooks.push(hook);
        return () => {};
      }),
      requireClient: vi.fn().mockReturnValue({
        abort: vi.fn().mockResolvedValue(undefined),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        // upstreamClearQueueSend 走私有 send()(issue #112 的 COMPAT 面);
        // 应答 data 语义 = 「被移除的消息」(本用例按镜像内容如实返回)。
        send: vi.fn().mockResolvedValue({ success: true, data: { steering: ["排队一", "排队二"], followUp: [] } }),
      }),
    } as unknown as PiRpc;
    const projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: false,
      allRpcs: vi.fn().mockReturnValue([rpc]),
    } as unknown as ProjectManager;
    const store = new ConfigStore({});
    const auth = new ChallengeAuth(() => {}, () => {});
    auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
    const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
    const pmctl = new PmctlController({ projectManager, roomOps, store });
    router = createMessageRouter({
      projectManager,
      auth,
      sendReply: async (chatId, transport, text) => {
        replies.push({ chatId, transport, text });
      },
      sendTyping: vi.fn(),
      roomOps,
      store,
      pmctl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Production wiring: queue_update feeds the mirror, a prompt binds the room. */
  const feedMirror = (steering: string[], followUp: string[] = []): void => {
    router.handleEvent({ type: "queue_update", steering, followUp }, rpc);
  };
  const bindRoom = async (): Promise<void> => {
    await router.handleIncoming(makeMsg({ messageId: `bind-${Math.random()}` }));
  };
  const restart = (): void => {
    for (const hook of restartHooks) hook(rpc);
  };

  it("non-empty mirror + restart → room gets the never-ran notice with the list", async () => {
    await bindRoom();
    feedMirror(["先查日志", "再重启服务"], ["回头补测试"]);
    restart();
    expect(replies).toHaveLength(1);
    expect(replies[0].chatId).toBe("!dm:server");
    expect(replies[0].text).toContain("3 条消息未执行");
    expect(replies[0].text).toContain("先查日志");
    expect(replies[0].text).toContain("回头补测试");
  });

  it("empty/absent mirror + restart → silence (nothing to lose)", async () => {
    await bindRoom();
    feedMirror([], []);
    restart();
    expect(replies).toHaveLength(0);
  });

  it("/stop's cleared-and-pinned mirror + restart → NO notice (self-cleared ≠ lost)", async () => {
    await bindRoom();
    feedMirror(["排队一", "排队二"]);
    await router.handleIncoming(makeMsg({ messageId: "stop", text: "/stop" }));
    expect(replies.at(-1)!.text).toContain("清掉 2 条排队消息");
    // 钉零之后即使上游 queue_update 推送尚未到达就重启,也不得误报。
    restart();
    expect(replies.some((r) => r.text.includes("未执行"))).toBe(false);
  });

  it("restart before any binding → log only, no throw, no reply", async () => {
    feedMirror(["从未绑定房间的队列"]);
    expect(() => restart()).not.toThrow();
    expect(replies).toHaveLength(0);
  });
});
