/**
 * Extension-UI 提问机模块直测(issue #54;spec #99 票3 / issue #104 抽模块)。
 *
 * 模块形状对照 LoginManager(tests/headless-login.test.ts 先例):不组装
 * router,直接对 ExtensionQuestions 驱动 —— 依赖全部注入(sendReply /
 * respond / timeoutMs / subscribeRestart),模块自持每进程 FIFO 队列与超时
 * 计时器。不变量:FIFO 最老优先、超时代答取消、invalid 重问不出队、无绑定
 * 代答取消、消息房间必须与提问房间一致、进程重启队列作废。
 *
 * 跨模块协作的接线断言(/ 前缀走命令通道、/reload 触发失效、登录捕获优先于
 * extension 捕获)留在 tests/router-extension-ui.test.ts 与
 * tests/router-login.test.ts。
 *
 * Upstream field mapping verified against
 * node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:
 * select/input/editor read `value`, confirm reads `confirmed`, and a
 * cancelled:true response resolves the dialog to its default value.
 */
import { describe, expect, it, vi } from "vitest";
import type { LeveledLogger } from "../src/logger";
import {
  ExtensionQuestions,
  type ExtensionUIRequestView,
  extensionUIQuestionText,
  extensionUiTimeoutMs,
  parseExtensionUIAnswer,
} from "../src/rpc/extension-questions";
import type { ExtensionUIResponsePayload, PiRpc } from "../src/rpc/pi-rpc";
import type { ExternalMessage, ReplyTarget } from "../src/types";

// --- fixtures -----------------------------------------------------------------

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

interface Reply {
  chatId: string;
  transport: string;
  text: string;
}

/** 安静日志器:模块测试不产生真实日志输出,只保证接口完整。 */
const silentLog: LeveledLogger = {
  setLogLevel: () => {},
  getLogLevel: () => "info",
  isEnabled: () => false,
  withLabel: () => silentLog,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * 提问机 + 注入依赖:sendReply / respond 录制房间回复与 extension_ui 回写;
 * subscribeRestart 按进程记录重启订阅,restart() 模拟子进程重启。
 * rpc 对提问机是不透明键(handle/deliver 只透传给 respond/订阅)。
 */
function makeMachine(opts: { timeoutMs?: number | (() => number); respondError?: Error } = {}) {
  const timeoutOpt = opts.timeoutMs;
  const replies: Reply[] = [];
  const responses: ExtensionUIResponsePayload[] = [];
  const listeners = new Map<PiRpc, Set<(rpc: PiRpc) => void>>();
  const machine = new ExtensionQuestions({
    sendReply: async (chatId, transport, text) => {
      replies.push({ chatId, transport, text });
    },
    respond: async (_rpc, payload) => {
      if (opts.respondError) throw opts.respondError;
      responses.push(payload);
    },
    timeoutMs: typeof timeoutOpt === "function" ? timeoutOpt : () => timeoutOpt ?? 600_000,
    subscribeRestart: (rpc, handler) => {
      const set = listeners.get(rpc) ?? new Set<(rpc: PiRpc) => void>();
      set.add(handler);
      listeners.set(rpc, set);
      return () => set.delete(handler);
    },
  });
  const rpc = { label: undefined } as unknown as PiRpc;
  const target: ReplyTarget = { chatId: "!dm:server", transport: "matrix", username: "barry" };
  /** 模拟子进程重启:触发该 rpc 的重启生命周期订阅(提问机应作废其队列)。 */
  const restart = (which: PiRpc = rpc) => {
    for (const handler of listeners.get(which) ?? []) handler(which);
  };
  const ask = (
    request: ExtensionUIRequestView,
    forRpc: PiRpc = rpc,
    forTarget: ReplyTarget | undefined = target
  ) => machine.handle(request, forRpc, forTarget, silentLog);  const deliver = (text: string, chatId = "!dm:server", forRpc: PiRpc = rpc) =>
    machine.deliver(forRpc, text, makeMsg({ text, chatId }), silentLog);
  return { machine, replies, responses, rpc, target, restart, ask, deliver };
}

// --- pure helpers (issue #54) ---------------------------------------------------

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

// --- question state machine (direct drive, no router) ---------------------------

describe("extension questions state machine (spec #99 ticket 3 / issue #104)", () => {
  it("a confirm request posts the question message to the question's target room", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toMatchObject({ chatId: "!dm:server", transport: "matrix" });
    expect(fx.replies[0].text).toContain("❓ 允许部署?");
    expect(fx.replies[0].text).toContain("将执行 deploy.sh");
    expect(fx.replies[0].text).toContain("回复 y / n(发送「取消」放弃)");
    expect(fx.responses).toHaveLength(0); // nothing written back yet
  });

  it("y answers confirmed:true, n answers confirmed:false, room gets ✅ 已回应", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    await expect(fx.deliver("y")).resolves.toBe(true);
    expect(fx.responses).toEqual([{ id: "q1", confirmed: true }]);
    expect(fx.replies.at(-1)!.text).toBe("✅ 已回应");

    fx.ask(uiRequest("q2"));
    await fx.deliver("N");
    expect(fx.responses).toEqual([
      { id: "q1", confirmed: true },
      { id: "q2", confirmed: false },
    ]);
  });

  it("invalid confirm input re-asks and keeps the question pending (nothing written back)", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    await expect(fx.deliver("maybe")).resolves.toBe(true); // consumed, but…
    expect(fx.responses).toHaveLength(0); // …nothing written back
    expect(fx.replies.at(-1)!.text).toContain("请回复 y 或 n");
    // The next message is still the answer (invalid did NOT dequeue).
    await fx.deliver("y");
    expect(fx.responses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("「取消」 writes cancelled:true and replies 已取消; the queue is drained", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    await fx.deliver("取消");
    expect(fx.responses).toEqual([{ id: "q1", cancelled: true }]);
    expect(fx.replies.at(-1)!.text).toBe("已取消");
    // Queue is drained: the next message is not consumed by the machine.
    await expect(fx.deliver("continue")).resolves.toBe(false);
  });

  it("select maps the 1-based index onto options; out-of-range re-asks", async () => {
    const fx = makeMachine();
    const select = uiRequest("q1", { method: "select", title: "选择环境", options: ["dev", "staging", "prod"] });
    fx.ask(select);
    expect(fx.replies[0].text).toContain("1. dev");
    expect(fx.replies[0].text).toContain("3. prod");

    await fx.deliver("9");
    expect(fx.responses).toHaveLength(0);
    expect(fx.replies.at(-1)!.text).toContain("请回复 1 到 3 之间的序号");

    await fx.deliver("3");
    expect(fx.responses).toEqual([{ id: "q1", value: "prod" }]);
  });

  it("input and editor take the whole message as the value", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1", { method: "input", title: "项目名", placeholder: "my-app" }));
    await fx.deliver("my fancy app");
    expect(fx.responses).toEqual([{ id: "q1", value: "my fancy app" }]);

    fx.ask(uiRequest("q2", { method: "editor", title: "编辑", prefill: "draft" }));
    await fx.deliver("first line\nsecond line");
    expect(fx.responses[1]).toEqual({ id: "q2", value: "first line\nsecond line" });
  });

  it("multiple pending questions: the oldest takes the answer first (FIFO)", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q-old"));
    fx.ask(uiRequest("q-new"));
    await fx.deliver("n");
    expect(fx.responses).toEqual([{ id: "q-old", confirmed: false }]);
    await fx.deliver("y");
    expect(fx.responses).toEqual([
      { id: "q-old", confirmed: false },
      { id: "q-new", confirmed: true },
    ]);
  });

  it("a message from a different room is not captured as the answer", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    await expect(fx.deliver("y", "!other:server")).resolves.toBe(false);
    expect(fx.responses).toHaveLength(0);
    // The question still answers from its own room.
    await expect(fx.deliver("y")).resolves.toBe(true);
    expect(fx.responses).toEqual([{ id: "q1", confirmed: true }]);
  });

  it("the queue is per pi process: another rpc's message never answers across processes", async () => {
    const fx = makeMachine();
    const otherRpc = { label: "proj" } as unknown as PiRpc;
    fx.ask(uiRequest("q-a"));
    fx.ask(uiRequest("q-b"), otherRpc);
    // The default rpc's oldest question answers; the project rpc's stays parked.
    await expect(fx.deliver("y")).resolves.toBe(true);
    expect(fx.responses).toEqual([{ id: "q-a", confirmed: true }]);
    await expect(fx.deliver("n", "!dm:server", otherRpc)).resolves.toBe(true);
    expect(fx.responses).toEqual([
      { id: "q-a", confirmed: true },
      { id: "q-b", confirmed: false },
    ]);
  });

  it("timeout (injected duration) answers cancelled and notifies the room", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeMachine({ timeoutMs: 600 });
      fx.ask(uiRequest("q1"));
      await vi.advanceTimersByTimeAsync(599);
      expect(fx.responses).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fx.responses).toEqual([{ id: "q1", cancelled: true }]);
      expect(fx.replies.at(-1)!.text).toContain("⌛ 问题「允许部署?」超时未答,已按取消处理");
      // After the timeout the machine no longer consumes room messages.
      await expect(fx.deliver("y")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the default timeout is 10 minutes when derived from a config without the field", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeMachine({ timeoutMs: () => extensionUiTimeoutMs({}) });
      fx.ask(uiRequest("q1"));
      await vi.advanceTimersByTimeAsync(599_999);
      expect(fx.responses).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fx.responses).toEqual([{ id: "q1", cancelled: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answering clears the timeout: an answered question never expires", async () => {
    vi.useFakeTimers();
    try {
      const fx = makeMachine({ timeoutMs: 600 });
      fx.ask(uiRequest("q1"));
      await fx.deliver("y");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fx.responses).toEqual([{ id: "q1", confirmed: true }]); // no cancelled duplicate
    } finally {
      vi.useRealTimers();
    }
  });

  it("a question with no target room is answered cancelled right away (never hangs)", async () => {
    const fx = makeMachine();
    fx.machine.handle(uiRequest("q1"), fx.rpc, undefined, silentLog);
    expect(fx.responses).toEqual([{ id: "q1", cancelled: true }]);
    expect(fx.replies).toHaveLength(0);
    // Nothing was parked: the next message is not consumed by the machine.
    await expect(fx.deliver("y")).resolves.toBe(false);
  });

  it("process restart drops pending questions: the next message is not an answer", async () => {
    const fx = makeMachine();
    fx.ask(uiRequest("q1"));
    fx.restart(); // the new subprocess never saw q1
    await expect(fx.deliver("deploy now")).resolves.toBe(false);
    expect(fx.responses).toHaveLength(0);
    expect(fx.replies.at(-1)!.text).not.toContain("已回应");
  });

  it("restart only invalidates its own process: other rpcs keep their questions", async () => {
    const fx = makeMachine();
    const otherRpc = { label: "proj" } as unknown as PiRpc;
    fx.ask(uiRequest("q-default"));
    fx.ask(uiRequest("q-proj"), otherRpc);
    fx.restart(); // only the default rpc restarted
    await expect(fx.deliver("y", "!dm:server", otherRpc)).resolves.toBe(true);
    expect(fx.responses).toEqual([{ id: "q-proj", confirmed: true }]);
  });

  it("a failed response write reports the failure and the question is gone", async () => {
    const fx = makeMachine({ respondError: new Error("pi exited") });
    fx.ask(uiRequest("q1"));
    await fx.deliver("y");
    expect(fx.replies.at(-1)!.text).toBe("❌ 答案无法回传给 pi(进程可能已退出)");
    expect(fx.replies.at(-1)!.text).not.toContain("已回应");
    // The entry was already dequeued — the room is not stuck answering a ghost.
    await expect(fx.deliver("y")).resolves.toBe(false);
  });

  it("notify warning and error reach the room; info only logs; nothing writes back", async () => {
    const fx = makeMachine();
    fx.ask({ type: "extension_ui_request", id: "n1", method: "notify", message: "磁盘快满", notifyType: "warning" } as ExtensionUIRequestView);
    expect(fx.replies.at(-1)!.text).toContain("⚠️ 扩展通知: 磁盘快满");

    fx.ask({ type: "extension_ui_request", id: "n2", method: "notify", message: "部署失败", notifyType: "error" } as ExtensionUIRequestView);
    expect(fx.replies.at(-1)!.text).toContain("🔴 扩展通知: 部署失败");

    const afterError = fx.replies.length;
    fx.ask({ type: "extension_ui_request", id: "n3", method: "notify", message: "进度 50%" } as ExtensionUIRequestView);
    expect(fx.replies).toHaveLength(afterError); // info stays in the log
    expect(fx.responses).toHaveLength(0); // notify never answers back

    // A warning with no bound room stays in the log — never fabricated into a DM.
    fx.machine.handle({ type: "extension_ui_request", id: "n4", method: "notify", message: "无房间的警告", notifyType: "warning" } as ExtensionUIRequestView, fx.rpc, undefined, silentLog);
    expect(fx.replies).toHaveLength(afterError);
  });

  it("TUI-only display methods (setStatus/setWidget/setTitle/set_editor_text) are ignored", () => {
    const fx = makeMachine();
    const before = fx.replies.length;
    for (const [method, extra] of [
      ["setStatus", { statusKey: "k", statusText: "v" }],
      ["setWidget", { widgetKey: "k", widgetLines: ["l"] }],
      ["setTitle", { title: "t" }],
      ["set_editor_text", { text: "e" }],
    ] as Array<[string, Record<string, unknown>]>) {
      fx.ask({ type: "extension_ui_request", id: `x-${method}`, method, ...extra } as ExtensionUIRequestView);
    }
    expect(fx.replies).toHaveLength(before);
    expect(fx.responses).toHaveLength(0);
  });
});
