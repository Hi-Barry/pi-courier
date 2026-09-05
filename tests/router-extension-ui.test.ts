/**
 * Extension UI interaction (issue #54, spec #51 ticket 3).
 *
 * Extensions ask questions over RPC (confirm/select/input/editor). The router
 * posts the question to the bound room, parks it in a per-rpc FIFO, and maps
 * the user's next plain message onto the extension_ui_response payload (y/n
 * for confirm, 1-based index for select, raw value for input/editor). 「取消」
 * backs out; a courier-side timeout answers cancelled when nobody replies;
 * notify is presented by level; TUI-only display methods are ignored.
 *
 * Upstream field mapping verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:
 * select/input/editor read `value`, confirm reads `confirmed`, and a
 * cancelled:true response resolves the dialog to its default value.
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import {
  createMessageRouter,
  type ExtensionUIRequestView,
  extensionUIQuestionText,
  extensionUiTimeoutMs,
  parseExtensionUIAnswer,
} from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { ExtensionUIResponsePayload, PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

function makeMsg(overrides: Partial<ExternalMessage> = {}): ExternalMessage {
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    content: "hi",
    isGroupChat: false,
    wasMentioned: false,
    messageId: "m1",
    timestamp: new Date(),
    ...overrides,
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
 * reply stream free of branding noise. ONE router per fixture — the pending
 * question queue lives inside the router instance.
 */
function makeFixtures(opts: { extensionUiTimeoutMinutes?: number } = {}) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const extensionResponses: ExtensionUIResponsePayload[] = [];
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    promptQueued: vi.fn().mockResolvedValue(undefined),
    respondExtensionUI: vi.fn().mockImplementation(async (payload: ExtensionUIResponsePayload) => {
      extensionResponses.push(payload);
    }),
    getState: vi.fn().mockResolvedValue({ model: { id: "m" }, isStreaming: false, pendingMessageCount: 0 }),
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
  await fx.router.handleIncoming(makeMsg({ content: "start a task" }));
  (fx.rpc.prompt as ReturnType<typeof vi.fn>).mockClear(); // the binding prompt is not under test
  fx.router.handleEvent(request, fx.rpc);
}

describe("extension UI pure helpers (issue #54)", () => {
  it("extensionUiTimeoutMs defaults to 10 minutes and reads the config value", () => {
    expect(extensionUiTimeoutMs({})).toBe(600_000);
    expect(extensionUiTimeoutMs({ extensionUiTimeoutMinutes: 5 })).toBe(300_000);
    expect(extensionUiTimeoutMs({ extensionUiTimeoutMinutes: 0.01 })).toBe(600);
  });

  it("question text per method states the answer protocol", () => {
    const confirm = extensionUIQuestionText(uiRequest("1"));
    expect(confirm).toContain("❓ 允许部署?");
    expect(confirm).toContain("将执行 deploy.sh");
    expect(confirm).toContain("回复 y / n");
    expect(confirm).toContain("「取消」");

    const select = extensionUIQuestionText(uiRequest("2", { method: "select", title: "选一个", options: ["alpha", "beta"] }));
    expect(select).toContain("1. alpha");
    expect(select).toContain("2. beta");
    expect(select).toContain("回复序号选择");

    for (const method of ["input", "editor"] as const) {
      const text = extensionUIQuestionText(uiRequest("3", { method, title: "输入" }));
      expect(text).toContain("❓ 输入");
      expect(text).toContain("直接回复内容作为答案");
      expect(text).toContain("「取消」");
    }
  });

  it("parse: confirm maps y/yes/n/no case-insensitively, anything else re-asks", () => {
    const req = uiRequest("1");
    expect(parseExtensionUIAnswer(req, "y")).toEqual({ kind: "confirmed", confirmed: true });
    expect(parseExtensionUIAnswer(req, "YES")).toEqual({ kind: "confirmed", confirmed: true });
    expect(parseExtensionUIAnswer(req, "n")).toEqual({ kind: "confirmed", confirmed: false });
    expect(parseExtensionUIAnswer(req, "No")).toEqual({ kind: "confirmed", confirmed: false });
    expect(parseExtensionUIAnswer(req, "maybe").kind).toBe("invalid");
  });

  it("parse: select maps the 1-based index, out-of-range re-asks", () => {
    const req = uiRequest("1", { method: "select", options: ["a", "b", "c"] });
    expect(parseExtensionUIAnswer(req, "2")).toEqual({ kind: "value", value: "b" });
    expect(parseExtensionUIAnswer(req, "0").kind).toBe("invalid");
    expect(parseExtensionUIAnswer(req, "4").kind).toBe("invalid");
    expect(parseExtensionUIAnswer(req, "abc").kind).toBe("invalid");
  });

  it("parse: input/editor take the whole message; 「取消」 cancels everywhere (exact match)", () => {
    expect(parseExtensionUIAnswer(uiRequest("1", { method: "input" }), "hello world")).toEqual({
      kind: "value",
      value: "hello world",
    });
    expect(parseExtensionUIAnswer(uiRequest("1", { method: "editor" }), "multi\nline")).toEqual({
      kind: "value",
      value: "multi\nline",
    });
    for (const method of ["confirm", "select", "input", "editor"]) {
      expect(parseExtensionUIAnswer(uiRequest("1", { method }), "取消")).toEqual({ kind: "cancel" });
    }
    // 「取消」 is exact: anything else is NOT a cancel.
    expect(parseExtensionUIAnswer(uiRequest("1", { method: "input" }), "取消部署").kind).toBe("value");
  });
});

describe("extension UI questions in the room (issue #54)", () => {
  it("a confirm request posts the question message to the bound room", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toMatchObject({ chatId: "!dm:server", transport: "matrix" });
    expect(fx.replies[0].text).toContain("❓ 允许部署?");
    expect(fx.replies[0].text).toContain("将执行 deploy.sh");
    expect(fx.replies[0].text).toContain("回复 y / n(发送「取消」放弃)");
    expect(fx.extensionResponses).toHaveLength(0); // nothing written back yet
  });

  it("y answers confirmed:true, n answers confirmed:false, room gets ✅ 已回应", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m2" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
    expect(fx.replies.at(-1)!.text).toBe("✅ 已回应");

    await fx.router.handleEvent(uiRequest("q2"), fx.rpc);
    await fx.router.handleIncoming(makeMsg({ content: "N", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([
      { id: "q1", confirmed: true },
      { id: "q2", confirmed: false },
    ]);
  });

  it("invalid confirm input re-asks and keeps the question pending (nothing written back)", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ content: "maybe", messageId: "m2" }));
    expect(fx.extensionResponses).toHaveLength(0);
    expect(fx.replies.at(-1)!.text).toContain("请回复 y 或 n");
    expect(fx.rpc.prompt).not.toHaveBeenCalled(); // not a prompt either
    // The next message is still the answer.
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("「取消」 writes cancelled:true and replies 已取消", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ content: "取消", messageId: "m2" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", cancelled: true }]);
    expect(fx.replies.at(-1)!.text).toBe("已取消");
    // Queue is drained: the next message is a normal prompt again.
    await fx.router.handleIncoming(makeMsg({ content: "continue", messageId: "m3" }));
    expect(fx.rpc.prompt).toHaveBeenCalledWith("continue");
  });

  it("select maps the 1-based index onto options; out-of-range re-asks", async () => {
    const fx = makeFixtures();
    const select = uiRequest("q1", { method: "select", title: "选择环境", options: ["dev", "staging", "prod"] });
    await askInDm(fx, select);
    expect(fx.replies[0].text).toContain("1. dev");
    expect(fx.replies[0].text).toContain("3. prod");

    await fx.router.handleIncoming(makeMsg({ content: "9", messageId: "m2" }));
    expect(fx.extensionResponses).toHaveLength(0);
    expect(fx.replies.at(-1)!.text).toContain("请回复 1 到 3 之间的序号");

    await fx.router.handleIncoming(makeMsg({ content: "3", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", value: "prod" }]);
  });

  it("input and editor take the whole message as the value", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1", { method: "input", title: "项目名", placeholder: "my-app" }));
    await fx.router.handleIncoming(makeMsg({ content: "my fancy app", messageId: "m2" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", value: "my fancy app" }]);

    await fx.router.handleEvent(uiRequest("q2", { method: "editor", title: "编辑", prefill: "draft" }), fx.rpc);
    await fx.router.handleIncoming(makeMsg({ content: "first line\nsecond line", messageId: "m3" }));
    expect(fx.extensionResponses[1]).toEqual({ id: "q2", value: "first line\nsecond line" });
  });

  it("multiple pending questions: the oldest takes the answer first", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q-old"));
    fx.router.handleEvent(uiRequest("q-new"), fx.rpc);
    await fx.router.handleIncoming(makeMsg({ content: "n", messageId: "m2" }));
    expect(fx.extensionResponses).toEqual([{ id: "q-old", confirmed: false }]);
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([
      { id: "q-old", confirmed: false },
      { id: "q-new", confirmed: true },
    ]);
  });

  it("while a question is pending, slash commands still go through the command channel", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ content: "/help", messageId: "m2" }));
    expect(fx.extensionResponses).toHaveLength(0); // not eaten as an answer
    expect(fx.replies.at(-1)!.text).toContain("Pi 命令");
    // ...and the question is still pending afterwards.
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("a message from a different room is not captured as the answer", async () => {
    const fx = makeFixtures();
    await askInDm(fx, uiRequest("q1"));
    await fx.router.handleIncoming(makeMsg({ chatId: "!other:server", content: "y", messageId: "m2" }));
    expect(fx.extensionResponses).toHaveLength(0); // other room's message goes to prompt
    expect(fx.rpc.prompt).toHaveBeenCalledWith("y");
    // The question still answers from its own room.
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m3" }));
    expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("timeout (config value, small for tests) answers cancelled and notifies the room", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixtures({ extensionUiTimeoutMinutes: 0.01 }); // 600 ms
      await askInDm(fx, uiRequest("q1"));
      await vi.advanceTimersByTimeAsync(599);
      expect(fx.extensionResponses).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fx.extensionResponses).toEqual([{ id: "q1", cancelled: true }]);
      expect(fx.replies.at(-1)!.text).toContain("⌛ 问题「允许部署?」超时未答,已按取消处理");
      // After the timeout the room accepts normal prompts again.
      await fx.router.handleIncoming(makeMsg({ content: "continue", messageId: "m2" }));
      expect(fx.rpc.prompt).toHaveBeenCalledWith("continue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default timeout is 10 minutes when the config field is absent", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixtures(); // no extensionUiTimeoutMinutes
      await askInDm(fx, uiRequest("q1"));
      await vi.advanceTimersByTimeAsync(599_999);
      expect(fx.extensionResponses).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fx.extensionResponses).toEqual([{ id: "q1", cancelled: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answering clears the timeout: an answered question never expires", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeFixtures({ extensionUiTimeoutMinutes: 0.01 });
      await askInDm(fx, uiRequest("q1"));
      await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m2" }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]); // no cancelled duplicate
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("extension UI fire-and-forget requests (issue #54)", () => {
  it("notify warning and error reach the room; info only logs", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "hi" }));

    fx.router.handleEvent({ type: "extension_ui_request", id: "n1", method: "notify", message: "磁盘快满", notifyType: "warning" }, fx.rpc);
    expect(fx.replies.at(-1)!.text).toContain("⚠️ 扩展通知: 磁盘快满");

    fx.router.handleEvent({ type: "extension_ui_request", id: "n2", method: "notify", message: "部署失败", notifyType: "error" }, fx.rpc);
    expect(fx.replies.at(-1)!.text).toContain("🔴 扩展通知: 部署失败");

    const before = fx.replies.length;
    fx.router.handleEvent({ type: "extension_ui_request", id: "n3", method: "notify", message: "进度 50%" }, fx.rpc);
    expect(fx.replies).toHaveLength(before);
    expect(fx.extensionResponses).toHaveLength(0); // notify never answers back
  });

  it("TUI-only display methods (setStatus/setWidget/setTitle/set_editor_text) are ignored", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "hi" }));
    const before = fx.replies.length;
    for (const [method, extra] of [
      ["setStatus", { statusKey: "k", statusText: "v" }],
      ["setWidget", { widgetKey: "k", widgetLines: ["l"] }],
      ["setTitle", { title: "t" }],
      ["set_editor_text", { text: "e" }],
    ] as Array<[string, Record<string, unknown>]>) {
      fx.router.handleEvent({ type: "extension_ui_request", id: `x-${method}`, method, ...extra }, fx.rpc);
    }
    expect(fx.replies).toHaveLength(before);
    expect(fx.extensionResponses).toHaveLength(0);
  });

  it("a question with no bound room is answered cancelled right away (never hangs)", async () => {
    const fx = makeFixtures();
    // No prompt beforehand: the rpc has no binding.
    fx.router.handleEvent(uiRequest("q1"), fx.rpc);
    expect(fx.extensionResponses).toEqual([{ id: "q1", cancelled: true }]);
    expect(fx.replies).toHaveLength(0);
    // Nothing was parked: the next message is a plain prompt, not an answer.
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m1" }));
    expect(fx.rpc.prompt).toHaveBeenCalledWith("y");
  });
});
