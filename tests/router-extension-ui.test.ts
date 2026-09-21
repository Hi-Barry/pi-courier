/**
 * Extension UI × router 接线(spec #99 票3 / issue #104 抽模块后保留的
 * router 级用例)。
 *
 * 提问机的状态机不变量(FIFO 最老优先、超时代答、invalid 重问不出队、无
 * 绑定代答取消、通知分档、TUI 专属忽略、纯函数映射)已随模块迁到
 * tests/extension-questions.test.ts 直测(不组装 router,先例:headless-
 * login.test.ts 测 LoginManager)。这里只留跨模块协作断言:
 *   • 事件路径把 extension_ui_request 接到提问机、目标房间来自 RoomBinding;
 *   • 悬置提问期间 `/` 前缀仍走命令通道(管道 × 提问机);
 *   • /reload 的重启生命周期触发提问机失效(命令 × rpc × 提问机);
 *   • 无绑定房间的事件以 undefined target 到达提问机(代答取消接线)。
 * 登录捕获优先于 extension 捕获的优先级断言在 tests/router-login.test.ts。
 *
 * Upstream field mapping verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:
 * select/input/editor read `value`, confirm reads `confirmed`, and a
 * cancelled:true response resolves the dialog to its default value.
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import { createMessageRouter } from "../src/rpc/message-router";
import type { ExtensionUIRequestView } from "../src/rpc/extension-questions";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { ExtensionUIResponsePayload, PiRpc } from "../src/rpc/pi-rpc";
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

/** A confirm-shaped extension_ui_request (the wire shape per rpc-types.d.ts). */
function uiRequest(id: string, overrides: Record<string, unknown> = {}): ExtensionUIRequestView {
  return {
    type: "extension_ui_request",
    id,
    method: "confirm",
    title: "允许部署?",
    message: "将执行 deploy.sh",
    ...overrides,
  } as ExtensionUIRequestView;
}

/**
 * Fixtures mirroring the router-projects pattern: mock PiRpc (extended with
 * respondExtensionUI, which records the回写 payloads), real ChallengeAuth
 * (barry = admin + trusted), replies collector. Single-project mode keeps the
 * reply stream free of branding noise. ONE router per fixture — the question
 * machine (and its FIFO) lives inside the router instance.
 */
function makeFixtures(opts: { extensionUiTimeoutMinutes?: number } = {}) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const extensionResponses: ExtensionUIResponsePayload[] = [];
  const restartListeners = new Set<(r: unknown) => void>();
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    promptQueued: vi.fn().mockResolvedValue(undefined),
    respondExtensionUI: vi.fn().mockImplementation(async (payload: ExtensionUIResponsePayload) => {
      extensionResponses.push(payload);
    }),
    getState: vi.fn().mockResolvedValue({ model: { id: "m" }, isStreaming: false, pendingMessageCount: 0 }),
    onRestarted: vi.fn((listener: (r: unknown) => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    }),
    restart: vi.fn(async () => {
      for (const listener of restartListeners) listener(rpc);
    }),
    requireClient: () => rpc,
    onEvent: vi.fn(),
  } as unknown as PiRpc;
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: false,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ProjectManager;
  const store = new ConfigStore({
    ...(opts.extensionUiTimeoutMinutes !== undefined
      ? { extensionUiTimeoutMinutes: opts.extensionUiTimeoutMinutes }
      : {}),
  });
  const auth = new ChallengeAuth(
    () => {},
    () => {}
  );
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server"],
    adminUserId: "matrix:@barry:server",
    channels: {},
  });
  const sendTyping = vi.fn(async (_chatId: string, _transport: string): Promise<void> => {});
  // Only getBotUserId can be reached in single-project mode; cast keeps the
  // stub minimal (mirrors the roomOps shape in router-projects.test.ts).
  const roomOps = {
    getBotUserId: vi.fn().mockReturnValue("@bot:server"),
  } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl });
  return { replies, extensionResponses, rpc, store, router };
}

/** Bind the rpc to the DM (as any real prompt would) and ask a question. */
async function askInDm(
  fx: ReturnType<typeof makeFixtures>,
  request: ExtensionUIRequestView
): Promise<void> {
  await fx.router.handleIncoming(makeMsg({ text: "start a task" }));
  (fx.rpc.prompt as ReturnType<typeof vi.fn>).mockClear(); // the binding prompt is not under test
  fx.router.handleEvent(request, fx.rpc);
}

describe("extension UI × router wiring (spec #99 ticket 3 / issue #104)", () => {
  it("a confirm request on the event path posts the question message to the bound room", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toMatchObject({ chatId: "!dm:server", transport: "matrix" });
    expect(fx.replies[0].text).toContain("❓ 允许部署?");
    expect(fx.replies[0].text).toContain("将执行 deploy.sh");
    expect(fx.replies[0].text).toContain("回复 y / n(发送「取消」放弃)");
    expect(fx.extensionResponses).toHaveLength(0); // nothing written back yet
  });

  it("while a question is pending, slash commands still go through the command channel", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ text: "/help", messageId: "m2" }));
    expect(fx.extensionResponses).toHaveLength(0); // not eaten as an answer
    expect(fx.replies.at(-1)!.text).toContain("Pi 命令");
    // ...and the question is still pending afterwards.
    await fx.router.handleIncoming(makeMsg({ text: "y", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("/reload drops pending questions: the next plain message prompts instead of answering", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ text: "/reload", messageId: "m2" }));
    expect(fx.rpc.restart).toHaveBeenCalledTimes(1);
    // The new subprocess never sees question q1 — its room message must be a
    // prompt, not a bogus "✅ 已回应" answer to a dead question.
    await fx.router.handleIncoming(makeMsg({ text: "deploy now", messageId: "m3" }));
    expect(fx.rpc.prompt).toHaveBeenCalledWith("deploy now");
    expect(fx.rpc.respondExtensionUI).not.toHaveBeenCalled();
    expect(fx.replies.at(-1)!.text).not.toContain("已回应");
  });

  it("a question with no bound room is answered cancelled right away (never hangs)", async () => {
    const fx = makeFixtures();
    // No prompt beforehand: the rpc has no binding.
    fx.router.handleEvent(uiRequest("q1"), fx.rpc);
    expect(fx.extensionResponses).toEqual([{ id: "q1", cancelled: true }]);
    expect(fx.replies).toHaveLength(0);
    // Nothing was parked: the next message is a plain prompt, not an answer.
    await fx.router.handleIncoming(makeMsg({ text: "y", messageId: "m1" }));
    expect(fx.rpc.prompt).toHaveBeenCalledWith("y");
  });
});
