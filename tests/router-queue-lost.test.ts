/**
 * 非自愿队列丢失回执(issue #115 阶段1)through the router: REAL
 * RpcTransientState + REAL restart lifecycle — the queue mirror is fed by
 * queue_update events (the same path production uses), the restart is fired
 * through PiRpc.onRestarted, and only the transport/rpc boundaries are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageRouter } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import { makeMsg, makeRouterFixture } from "./helpers";

describe("queue lost notice on subprocess restart (issue #115 stage 1)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let restartHooks: Array<(rpc: PiRpc) => void>;
  let rpc: PiRpc;
  let router: MessageRouter;

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
    router = makeRouterFixture({
      rpc,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
    }).router;
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

describe("queue snapshot persistence through the router (issue #115 stage 2)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let restartHooks: Array<(rpc: PiRpc) => void>;
  let defaultRpc: PiRpc;
  let projectRpc: PiRpc;
  let saved: Array<{ roomId: string; snapshot: unknown }>;
  let router: MessageRouter;

  beforeEach(() => {
    replies = [];
    restartHooks = [];
    saved = [];
    const makeRpc = (label?: string): PiRpc =>
      ({
        prompt: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
        label,
        onEvent: vi.fn(),
        onRestarted: vi.fn((hook: (rpc: PiRpc) => void) => {
          restartHooks.push(hook);
          return () => {};
        }),
        requireClient: vi.fn().mockReturnValue({
          abort: vi.fn().mockResolvedValue(undefined),
          waitForIdle: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue({ success: true, data: { steering: ["排队一"], followUp: [] } }),
        }),
      }) as unknown as PiRpc;
    defaultRpc = makeRpc();
    projectRpc = makeRpc("proj-a");
    const projectManager = {
      getRpcForRoom: vi.fn((roomId: string) => (roomId === "!proj:s" ? projectRpc : defaultRpc)),
      isProjectRoom: vi.fn((roomId: string) => roomId === "!proj:s"),
      labelForRoom: vi.fn((roomId: string) => (roomId === "!proj:s" ? "proj-a" : undefined)),
      roomForRpc: vi.fn((rpc: PiRpc) => (rpc === projectRpc ? "!proj:s" : undefined)),
      isMultiProject: true,
      allRpcs: vi.fn().mockReturnValue([defaultRpc, projectRpc]),
    } as unknown as ProjectManager;
    router = makeRouterFixture({
      rpc: defaultRpc,
      projectManager,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
      // 存储缝用假件记账(save/remove 的盘上语义归 queue-snapshots.test.ts)
      extra: {
        queueSnapshots: {
          save: (roomId: string, snapshot: unknown) => {
            saved.push({ roomId, snapshot });
          },
        } as never,
      },
    }).router;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const restart = (): void => {
    for (const hook of restartHooks) hook(projectRpc);
  };

  it("queue_update on a project rpc → snapshot saved under the project room", async () => {
    await router.handleIncoming(makeMsg({ chatId: "!proj:s", messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["先查日志"], followUp: ["再补测试"] }, projectRpc);
    expect(saved).toEqual([
      { roomId: "!proj:s", snapshot: { steering: ["先查日志"], followUp: ["再补测试"] } },
    ]);
  });

  it("queue_update draining to empty → empty snapshot saved (store removes the entry)", async () => {
    await router.handleIncoming(makeMsg({ chatId: "!proj:s", messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["排队中"], followUp: [] }, projectRpc);
    router.handleEvent({ type: "queue_update", steering: [], followUp: [] }, projectRpc);
    expect(saved[1]).toEqual({ roomId: "!proj:s", snapshot: { steering: [], followUp: [] } });
  });

  it("/stop's pin-to-empty reaches the store (self-cleared never survives a restart)", async () => {
    await router.handleIncoming(makeMsg({ chatId: "!proj:s", messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["排队一"], followUp: [] }, projectRpc);
    await router.handleIncoming(makeMsg({ chatId: "!proj:s", messageId: "stop", text: "/stop" }));
    expect(saved.at(-1)).toEqual({ roomId: "!proj:s", snapshot: { steering: [], followUp: [] } });
  });

  it("project-process restart → stage-1 notice AND empty snapshot (no double report next service start)", async () => {
    await router.handleIncoming(makeMsg({ chatId: "!proj:s", messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["排队一", "排队二"], followUp: [] }, projectRpc);
    restart();
    expect(replies[0].chatId).toBe("!proj:s");
    expect(replies[0].text).toContain("2 条消息未执行");
    expect(saved.at(-1)).toEqual({ roomId: "!proj:s", snapshot: { steering: [], followUp: [] } });
  });

  it("the default process is never persisted (single-project conservative route)", async () => {
    await router.handleIncoming(makeMsg({ chatId: "!dm:server", messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["默认进程的队列"], followUp: [] }, defaultRpc);
    expect(saved).toEqual([]);
  });
});
