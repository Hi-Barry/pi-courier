/**
 * 离线收件箱的 router 侧(issue #113):真实管道 + fake timers —— transport
 * 判定好的 replayed 消息进 router 后,缓冲、征询、执行/忽略/超时三路、
 * auto 模式、授权门控与 per-room 隔离全在本文件钉死。rpc/授权边界 fake,
 * 其余全真。
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
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    ...rest,
  };
}

describe("offline inbox settlement (issue #113)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let prompt: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createMessageRouter>;
  let store: ConfigStore;

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    prompt = vi.fn().mockResolvedValue(undefined);
    store = new ConfigStore({});
    router = buildRouter(store, prompt);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildRouter(
    store: ConfigStore,
    prompt: ReturnType<typeof vi.fn>,
    trusted: string[] = ["matrix:@barry:server"],
    channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> = {}
  ) {
    const rpc = {
      prompt,
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const projectManager = {
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: false,
      allRpcs: vi.fn().mockReturnValue([rpc]),
    } as unknown as ProjectManager;
    const auth = new ChallengeAuth(() => {}, () => {});
    auth.loadFromConfig({ trustedUsers: trusted, adminUserId: "matrix:@barry:server", channels });
    const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
    const pmctl = new PmctlController({ projectManager, roomOps, store });
    return createMessageRouter({
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
  }

  const backlog = (text: string, overrides: Partial<ExternalMessage> = {}): ExternalMessage =>
    makeMsg({ text, replayed: true, ...overrides });

  it("replayed messages buffer first — nothing reaches pi until settled", async () => {
    await router.handleIncoming(backlog("先看日志"));
    await router.handleIncoming(backlog("再重启服务"));
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("2 条消息");
    expect(replies[0]!.text).toContain("先看日志");
    expect(replies[0]!.text).toContain("再重启服务");
    expect(replies[0]!.text).toContain("执行");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("「执行」delivers in arrival order with the flag stripped; the answer itself is not prompted", async () => {
    await router.handleIncoming(backlog("第一条"));
    await router.handleIncoming(backlog("第二条"));
    await vi.advanceTimersByTimeAsync(5_000);
    await router.handleIncoming(makeMsg({ text: "执行" }));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls.map((c) => c[0])).toEqual(["第一条", "第二条"]);
    // 再注入剥掉了 replayed 标记:再注入的消息不会二次进缓冲(prompt 即证据)。
  });

  it("「忽略」discards with a receipt; later 执行 is then an ordinary message", async () => {
    await router.handleIncoming(backlog("会被丢弃"));
    await vi.advanceTimersByTimeAsync(5_000);
    await router.handleIncoming(makeMsg({ text: "忽略" }));
    expect(replies.at(-1)!.text).toContain("已忽略 1 条");
    expect(prompt).not.toHaveBeenCalled();
    // 征询已消费:再喊「执行」不再触发投递,而是当作普通消息发给 pi。
    await router.handleIncoming(makeMsg({ text: "执行" }));
    expect(prompt).toHaveBeenCalledWith("执行");
  });

  it("timeout silently discards — a late 执行 finds nothing pending", async () => {
    await router.handleIncoming(backlog("迟到的积压"));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await router.handleIncoming(makeMsg({ text: "执行" }));
    expect(prompt).toHaveBeenCalledWith("执行"); // 当普通消息,不是投递触发
    expect(replies.filter((r) => r.text.includes("按序处理"))).toHaveLength(1); // 只有当初那条征询
  });

  it("auto mode: notice then in-order delivery, no question asked", async () => {
    store = new ConfigStore({ inbox: { mode: "auto" } });
    prompt = vi.fn().mockResolvedValue(undefined);
    router = buildRouter(store, prompt);
    await router.handleIncoming(backlog("自动一号"));
    await router.handleIncoming(backlog("自动二号"));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls.map((c) => c[0])).toEqual(["自动一号", "自动二号"]);
    expect(replies[0]!.text).toContain("2 条");
    expect(replies[0]!.text).toContain("按序执行中");
  });

  it("a realtime message settles the pending backlog immediately (no 5s wait)", async () => {
    await router.handleIncoming(backlog("积压一下"));
    await router.handleIncoming(makeMsg({ text: "我回来了" }));
    expect(replies.some((r) => r.text.includes("1 条消息"))).toBe(true);
    expect(prompt).toHaveBeenCalledWith("我回来了"); // 实时消息照常处理
  });

  it("unauthorized sender's backlog never buffers (no privilege bypass via replay)", async () => {
    await router.handleIncoming(backlog("陌生人的积压", { userId: "@stranger:server", username: "stranger" }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies.filter((r) => r.text.includes("积压"))).toEqual([]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("rooms settle independently — one room's prompt never merges another's", async () => {
    await router.handleIncoming(backlog("A 房消息", { chatId: "!a:server" }));
    await router.handleIncoming(backlog("B 房消息", { chatId: "!b:server" }));
    await vi.advanceTimersByTimeAsync(5_000);
    const prompts = replies.filter((r) => r.text.includes("1 条消息"));
    expect(prompts).toHaveLength(2);
    expect(prompts.map((r) => r.chatId).sort()).toEqual(["!a:server", "!b:server"]);
  });

  it("multi-sender backlog lists each sender (group rooms)", async () => {
    router = buildRouter(store, prompt, ["matrix:@barry:server", "matrix:@alice:server"], {
      "!dm:server": { enabled: true, mode: "all" }, // 群房默认未启用即吞:本测试先启用
    });
    await router.handleIncoming(backlog("我的消息"));
    await router.handleIncoming(
      backlog("同事的消息", { userId: "@alice:server", username: "alice", isGroupChat: true })
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const promptReply = replies.at(-1)!.text;
    expect(promptReply).toContain("@barry");
    expect(promptReply).toContain("@alice");
  });

  it("answer words are bilingual: run/execute also deliver, cancel words also discard", async () => {
    await router.handleIncoming(backlog("双语一号"));
    await vi.advanceTimersByTimeAsync(5_000);
    await router.handleIncoming(makeMsg({ text: "run" }));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("双语一号"));

    await router.handleIncoming(backlog("双语二号"));
    await vi.advanceTimersByTimeAsync(5_000);
    await router.handleIncoming(makeMsg({ text: "cancel" }));
    expect(replies.at(-1)!.text).toContain("已忽略 1 条");
    expect(prompt).not.toHaveBeenCalledWith("双语二号");
  });
});
