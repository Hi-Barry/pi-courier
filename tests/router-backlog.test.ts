/**
 * 离线收件箱的 router 侧(issue #113):真实管道 + fake timers —— transport
 * 判定好的 replayed 消息进 router 后,缓冲、征询、执行/忽略/超时三路、
 * auto 模式、授权门控与 per-room 隔离全在本文件钉死。rpc/授权边界 fake,
 * 其余全真。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import type { MessageRouter } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ExternalMessage } from "../src/types";
import { makeMsg, makeRouterFixture } from "./helpers";

describe("offline inbox settlement (issue #113)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let prompt: ReturnType<typeof vi.fn>;
  let router: MessageRouter;
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
    channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> = {},
    transportsReady?: Promise<void>
  ) {
    const rpc = {
      prompt,
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const fixture = makeRouterFixture({
      store,
      rpc,
      trusted,
      channels,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
      // #136 冻结信号经逃生舱透传;缺省(不传)= 已就绪,既有用例即旧语义钉。
      ...(transportsReady ? { extra: { backlogTransportsReady: transportsReady } } : {}),
    });
    return fixture.router;
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

  // ---- 结算冻结(#136 修法B):transport 连接阶段只缓冲不倒计时 -----------

  function freezeSignal() {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => (release = resolve));
    return { ready, release };
  }

  it("冻结窗:未就绪只缓冲不倒计时,放行后补起 5s(#136 修法B)", async () => {
    const signal = freezeSignal();
    router = buildRouter(store, prompt, ["matrix:@barry:server"], {}, signal.ready);
    await router.handleIncoming(backlog("冻结一号"));
    await router.handleIncoming(backlog("冻结二号"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(replies).toEqual([]); // 旧代码此处已丢积压:定时器在未连接里开火
    expect(prompt).not.toHaveBeenCalled();
    signal.release();
    await vi.advanceTimersByTimeAsync(0); // 放行回补定时器(微任务落定)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("2 条消息");
    expect(replies[0]!.text).toContain("冻结一号");
  });

  it("冻结窗内实时消息照旧立即结算(能收即活着,只冻定时器)", async () => {
    const signal = freezeSignal();
    router = buildRouter(store, prompt, ["matrix:@barry:server"], {}, signal.ready);
    await router.handleIncoming(backlog("冻结一"));
    await router.handleIncoming(makeMsg({ text: "我回来了" }));
    expect(replies.some((r) => r.text.includes("1 条消息"))).toBe(true);
    expect(prompt).toHaveBeenCalledWith("我回来了");
  });

  it("冻结信号 reject 视同放行,不永久冻结", async () => {
    router = buildRouter(store, prompt, ["matrix:@barry:server"], {}, Promise.reject(new Error("wiring bug")));
    await router.handleIncoming(backlog("照样结算"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("1 条消息");
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
