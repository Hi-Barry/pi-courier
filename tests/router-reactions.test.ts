/**
 * reaction 快捷应答的 router 侧(spec #267 票02,#269;票03 #270 追加 extension
 * 流):真实管道 + fake timers —— 统一入口的信任闸门(fail-closed)、积压征询
 * 的 ✅/❌ 种植与点击应答、extension 提问的端到端表情应答、噪音策略(超时/
 * 无主/未知 key 静默)与未注入缝的零回归全在本文件钉死。rpc/授权边界 fake,
 * 其余全真(与 router-backlog 同装配)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REACTION_APPROVE, REACTION_REJECT } from "../src/rpc/reactions";
import type { ExtensionUIRequestView } from "../src/rpc/extension-questions";
import type { ExtensionUIResponsePayload, PiRpc } from "../src/rpc/pi-rpc";
import type { MessageRouter } from "../src/rpc/message-router";
import type { MatrixReaction } from "../src/transports/matrix";
import type { ExternalMessage } from "../src/types";
import { ConfigStore } from "../src/config";
import { makeMsg, makeRouterFixture } from "./helpers";

describe("backlog confirm reactions (spec #267 票02)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let prompts: Array<{ chatId: string; transport: string; text: string }>;
  let planted: Array<{ chatId: string; eventId: string; emoji: string }>;
  let prompt: ReturnType<typeof vi.fn>;
  let router: MessageRouter;
  let store: ConfigStore;

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    prompts = [];
    planted = [];
    prompt = vi.fn().mockResolvedValue(undefined);
    store = new ConfigStore({});
    router = buildRouter();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** 注入 replyWithId/sendReaction 的装配(缺省路由器不带 = 功能禁用)。 */
  function buildRouter(trusted: string[] = ["matrix:@barry:server"]) {
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
      audit: true,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
      extra: {
        replyWithId: async (chatId: string, transport: string, text: string) => {
          prompts.push({ chatId, transport, text });
          return `evt-confirm-${prompts.length}`;
        },
        sendReaction: async (chatId: string, eventId: string, emoji: string) => {
          planted.push({ chatId, eventId, emoji });
        },
      },
    });
    return fixture.router;
  }

  const backlog = (text: string, overrides: Partial<ExternalMessage> = {}): ExternalMessage =>
    makeMsg({ text, replayed: true, ...overrides });

  const tap = (key: string, sender = "@barry:server", targetEventId?: string, chatId = "!dm:server"): MatrixReaction => ({
    chatId,
    targetEventId: targetEventId ?? `evt-confirm-1`,
    key,
    sender,
  });

  /** 征询发到位(5s 结算 + 微任务落定),返回征询 event_id。 */
  async function settleConfirm(text = "积压一条"): Promise<string> {
    await router.handleIncoming(backlog(text));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain(text);
    await vi.waitFor(() => expect(planted).toHaveLength(2));
    return `evt-confirm-1`;
  }

  it("征询发出后 bot 在其上种 ✅/❌(指向征询 event_id 的 fire-and-forget)", async () => {
    const confirmId = await settleConfirm();
    expect(planted.map((p) => p.emoji)).toEqual([REACTION_APPROVE, REACTION_REJECT]);
    expect(planted.every((p) => p.eventId === confirmId && p.chatId === "!dm:server")).toBe(true);
    expect(replies).toHaveLength(0); // 种表情不走 reply 缝(征询经 replyWithId)
  });

  it("点 ✅ 与文字「执行」同一出口:投递触发、审计留痕、悬置清理", async () => {
    const confirmId = await settleConfirm();
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", confirmId));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(prompt).toHaveBeenCalledWith("积压一条");
    expect(replies).toHaveLength(0); // 执行分支无回帖(与文字「执行」一致)
    // 悬置已清理:再点 ✅ 不再二次投递
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", confirmId));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("点 ✅ 的审计 actor 是点击者(与文字通道同一审计事件)", async () => {
    const fixture = makeRouterFixture({
      store,
      rpc: {
        prompt,
        getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
        label: undefined,
        onEvent: vi.fn(),
      } as unknown as PiRpc,
      audit: true,
      extra: {
        replyWithId: async () => `evt-confirm-1`,
        sendReaction: async () => {},
      },
    });
    await fixture.router.handleIncoming(backlog("审计一条"));
    await vi.advanceTimersByTimeAsync(5_000);
    fixture.router.handleReaction(tap(REACTION_APPROVE, "@barry:server", "evt-confirm-1"));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(fixture.auditLines.map((l) => l.event)).toEqual(["backlog.execute"]);
    expect(fixture.auditLines[0]!.actor).toBe("matrix:@barry:server");
    expect(fixture.auditLines[0]!.chatId).toBe("!dm:server");
  });

  it("点 ❌ 与文字「忽略」同一回执文案", async () => {
    const confirmId = await settleConfirm();
    router.handleReaction(tap(REACTION_REJECT, "@barry:server", confirmId));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]!.text).toContain("已忽略 1 条");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("非信任 sender 点击:静默丢弃(fail-closed),无投递无回帖", async () => {
    const confirmId = await settleConfirm();
    router.handleReaction(tap(REACTION_APPROVE, "@mallory:server", confirmId));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
    // 悬置仍在:信任用户随后点 ✅ 照常生效
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", confirmId));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it("超时后点击静默(仅日志,无投递无回帖)", async () => {
    await settleConfirm();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    router.handleReaction(tap(REACTION_APPROVE));
    router.handleReaction(tap(REACTION_REJECT));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("无主 targetEventId 与未知 key 一律静默", async () => {
    await settleConfirm();
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", "evt-somewhere-else"));
    router.handleReaction(tap("👍"));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("房间不匹配:reaction 发生在别的房间时静默", async () => {
    const confirmId = await settleConfirm();
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", confirmId, "!other:server"));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("新一轮结算并入旧待答后,旧征询的点击作废、新征询的点击生效", async () => {
    const firstId = await settleConfirm("第一波");
    // 第二波积压:实时消息到达触发立即结算(实时消息本身照常进 pi),并入
    // 旧待答,征询重发
    await router.handleIncoming(makeMsg({ text: "我回来了" }));
    expect(prompt).toHaveBeenCalledWith("我回来了");
    await router.handleIncoming(backlog("第二波", { replayed: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(planted.length).toBeGreaterThanOrEqual(4));
    expect(prompts).toHaveLength(2);
    const secondId = `evt-confirm-2`;
    const before = prompt.mock.calls.length;
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", firstId));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt.mock.calls.length).toBe(before); // 旧 id 已作废,零投递
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", secondId));
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledWith("第二波"));
    // 新征询的悬置 = 旧待答并入(第一波 + 第二波),点击投递两条
    expect(prompt.mock.calls.map((c) => c[0])).toEqual(["我回来了", "第一波", "第二波"]);
  });

  it("征询文案(zh 表为锚)写明表情与语义的对应关系", async () => {
    await settleConfirm();
    expect(prompts[0]!.text).toContain("也可点击下方表情:✅ 执行 / ❌ 忽略");
  });

  it("replyWithId/sendReaction 未注入:征询照走旧 reply,reaction 入口不消费", async () => {
    const rpc = {
      prompt,
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const fixture = makeRouterFixture({
      store,
      rpc,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
    });
    router = fixture.router;
    await router.handleIncoming(backlog("旧语义征询"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies).toHaveLength(1); // 征询照发(reply 缝)
    expect(replies[0]!.text).toContain("旧语义征询");
    // 表情点击即使真的到来(客户端残留)也不消费
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", "whatever"));
    await vi.advanceTimersByTimeAsync(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
  });
});

describe("extension question reactions end-to-end (spec #267 票03, #270)", () => {
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let prompts: Array<{ chatId: string; transport: string; text: string }>;
  let planted: Array<{ chatId: string; eventId: string; emoji: string }>;
  let extensionResponses: ExtensionUIResponsePayload[];
  let prompt: ReturnType<typeof vi.fn>;
  let router: MessageRouter;
  let store: ConfigStore;
  let rpc: PiRpc;

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    prompts = [];
    planted = [];
    extensionResponses = [];
    prompt = vi.fn().mockResolvedValue(undefined);
    store = new ConfigStore({});
    router = buildRouter();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** extension 流装配:rpc 带 respondExtensionUI,双缝录制提问卡与种植。 */
  function buildRouter(trusted: string[] = ["matrix:@barry:server"]) {
    rpc = {
      prompt,
      respondExtensionUI: vi.fn().mockImplementation(async (payload: ExtensionUIResponsePayload) => {
        extensionResponses.push(payload);
      }),
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const fixture = makeRouterFixture({
      store,
      rpc,
      trusted,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
      extra: {
        replyWithId: async (chatId: string, transport: string, text: string) => {
          prompts.push({ chatId, transport, text });
          return `evt-prompt-${prompts.length}`;
        },
        sendReaction: async (chatId: string, eventId: string, emoji: string) => {
          planted.push({ chatId, eventId, emoji });
        },
      },
    });
    return fixture.router;
  }

  /** 绑定房间后经事件路径发出一道 extension 提问,返回提问消息 event_id。 */
  async function askInDm(request: ExtensionUIRequestView): Promise<string> {
    await router.handleIncoming(makeMsg({ text: "start a task" }));
    prompt.mockClear(); // 绑定用的 prompt 不在被测断言里
    router.handleEvent(request, rpc);
    await vi.advanceTimersByTimeAsync(0); // 冲 replyWithId 微任务链
    expect(prompts).toHaveLength(1);
    return "evt-prompt-1";
  }

  const confirmRequest = (id = "q1"): ExtensionUIRequestView =>
    ({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: "允许部署?",
      message: "将执行 deploy.sh",
    }) as ExtensionUIRequestView;

  const tap = (key: string, sender = "@barry:server", targetEventId = "evt-prompt-1"): MatrixReaction => ({
    chatId: "!dm:server",
    targetEventId,
    key,
    sender,
  });

  it("confirm 提问在其消息上种 ✅/❌;点 ✅ → respond confirmed:true + 既有回执", async () => {
    const promptId = await askInDm(confirmRequest());
    expect(replies).toHaveLength(0); // 提问卡走 id 缝,不经 reply 缝
    expect(planted.map((p) => p.emoji)).toEqual([REACTION_APPROVE, REACTION_REJECT]);
    expect(planted.every((p) => p.eventId === promptId && p.chatId === "!dm:server")).toBe(true);

    router.handleReaction(tap(REACTION_APPROVE));
    await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(["✅ 已回应"]));
    expect(extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
    expect(prompt).not.toHaveBeenCalled(); // 不漏进对话管道
  });

  it("点 ❌ → respond confirmed:false", async () => {
    await askInDm(confirmRequest());
    router.handleReaction(tap(REACTION_REJECT));
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionResponses).toEqual([{ id: "q1", confirmed: false }]);
  });

  it("select 提问种键帽数字;点 2️⃣ → respond value=第 2 项", async () => {
    const select = {
      type: "extension_ui_request",
      id: "q1",
      method: "select",
      title: "选择环境",
      options: ["dev", "staging", "prod"],
    } as ExtensionUIRequestView;
    await askInDm(select);
    expect(planted.map((p) => p.emoji)).toEqual(["1️⃣", "2️⃣", "3️⃣"]);
    router.handleReaction(tap("2️⃣"));
    await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(["✅ 已回应"]));
    expect(extensionResponses).toEqual([{ id: "q1", value: "staging" }]);
  });

  it("非信任 sender 点击 extension 表情:闸门静默(fail-closed),信任用户随后可答", async () => {
    const promptId = await askInDm(confirmRequest());
    router.handleReaction(tap(REACTION_APPROVE, "@mallory:server", promptId));
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionResponses).toHaveLength(0);
    expect(replies).toHaveLength(0);
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", promptId));
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("extension 流在分发链上位于积压流之后:积压征询先认领,extension 不受干扰", async () => {
    // 只有 extension 悬置时,点击落在 extension(主链路已在上面钉死);这里钉
    // 无主 target 依旧全链静默(两流都没吃 → 仅 debug,无回帖无 respond)。
    await askInDm(confirmRequest());
    router.handleReaction(tap("👍", "@barry:server", "evt-prompt-1"));
    router.handleReaction(tap(REACTION_APPROVE, "@barry:server", "evt-unknown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionResponses).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it("replyWithId/sendReaction 未注入:extension 提问照走旧 reply 通道,点击静默", async () => {
    const rpc = {
      prompt,
      respondExtensionUI: vi.fn().mockImplementation(async (payload: ExtensionUIResponsePayload) => {
        extensionResponses.push(payload);
      }),
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const fixture = makeRouterFixture({
      store,
      rpc,
      sendReply: async (chatId: string, transport: string, text: string) => {
        replies.push({ chatId, transport, text });
      },
    });
    router = fixture.router;
    await router.handleIncoming(makeMsg({ text: "start a task" }));
    prompt.mockClear();
    router.handleEvent(confirmRequest(), rpc);
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(1); // 提问卡走旧 reply 通道
    expect(replies[0]!.text).toContain("❓ 允许部署?");
    expect(planted).toHaveLength(0);
    router.handleReaction(tap(REACTION_APPROVE));
    await vi.advanceTimersByTimeAsync(0);
    expect(extensionResponses).toHaveLength(0); // 表情入口不消费
    // 文字通道照常作答
    await router.handleIncoming(makeMsg({ text: "y", messageId: "m2" }));
    expect(extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });
});
