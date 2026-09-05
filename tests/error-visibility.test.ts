import { describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { buildTurnReply, createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { ExternalMessage } from "../src/types";

/**
 * Error visibility (issue #52, spec #51 票1): failed turns and auto-retry
 * progress must reach the bound room instead of disappearing silently, while
 * aborted turns (/stop) must never look like errors. Fixture construction
 * mirrors makeFixtures in tests/router-projects.test.ts (real ChallengeAuth +
 * mock PiRpc + a replies collector). managementRooms is pre-seeded so the
 * management-room adoption path never runs — these tests go through
 * store.update() nowhere, hence never touch the real ~/.pi config.
 */

/** Assistant-shaped message with the stop-reason fields pi actually sends. */
function assistantMessage(opts: { text?: string; stopReason?: string; errorMessage?: string } = {}): AssistantMessage {
  const content: Array<{ type: string; text?: string }> = [];
  if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
  return {
    role: "assistant",
    content,
    stopReason: opts.stopReason,
    errorMessage: opts.errorMessage,
  } as unknown as AssistantMessage;
}

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

function makeFixtures(opts: { projectRoom?: boolean } = {}) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const rpc = {
    prompt: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
  } as unknown as PiRpc;
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(opts.projectRoom ?? false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: true,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([] as Array<[string, { name?: string; workdir: string }]>),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ProjectManager;
  // Pre-seeded managementRooms keep adoption (and its store.update disk write) off.
  const store = new ConfigStore({ managementRooms: ["!dm:server"], projects: {}, multiProject: true });
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
  const pmctl = new PmctlController({ projectManager, store });
  const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping, store, pmctl });
  return { replies, rpc, projectManager, router, sendTyping };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildTurnReply error turns (issue #52)", () => {
  it("an error turn without content produces the failure line (no longer silent)", () => {
    const msg = assistantMessage({ stopReason: "error", errorMessage: "usage limit reached" });
    expect(buildTurnReply(msg)).toEqual({ text: "❌ 本轮失败: usage limit reached", pendingTools: false });
  });

  it("an error turn without an upstream message reports 未知错误", () => {
    const msg = assistantMessage({ stopReason: "error" });
    expect(buildTurnReply(msg)).toEqual({ text: "❌ 本轮失败: 未知错误", pendingTools: false });
  });

  it("an error turn keeps its partial text and appends the failure line", () => {
    const msg = assistantMessage({ text: "partial answer", stopReason: "error", errorMessage: "rate limited" });
    const turn = buildTurnReply(msg);
    expect(turn.pendingTools).toBe(false);
    expect(turn.text).toContain("partial answer");
    expect(turn.text).toContain("❌ 本轮失败: rate limited");
  });

  it("an aborted turn (no content) still yields null text — never an error notice", () => {
    const msg = assistantMessage({ stopReason: "aborted", errorMessage: "user cancelled" });
    expect(buildTurnReply(msg)).toEqual({ text: null, pendingTools: false });
  });
});

describe("error visibility routing (issue #52)", () => {
  it("an error turn with no text notifies the bound room and releases the default binding", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent(
      { type: "turn_end", message: assistantMessage({ stopReason: "error", errorMessage: "usage limit reached" }) },
      fx.rpc
    );
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toMatchObject({ chatId: "!dm:server", transport: "matrix" });
    expect(fx.replies[0].text).toContain("❌ 本轮失败: usage limit reached");

    // The failed turn released the unpinned binding: late events go nowhere.
    fx.router.handleEvent({ type: "extension_error", error: "late boom" }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(1);
  });

  it("an error turn with partial text replies once, content plus failure line", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent(
      {
        type: "turn_end",
        message: assistantMessage({ text: "partial answer", stopReason: "error", errorMessage: "rate limited" }),
      },
      fx.rpc
    );
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0].text).toContain("partial answer");
    expect(fx.replies[0].text).toContain("❌ 本轮失败: rate limited");
  });

  it("an aborted turn never produces an error notification", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent(
      { type: "turn_end", message: assistantMessage({ stopReason: "aborted", errorMessage: "user cancelled" }) },
      fx.rpc
    );
    await flush();
    expect(fx.replies).toHaveLength(0);
  });

  it("auto_retry_start notifies the room with n/N and the failure summary", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent(
      { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "429 too many requests" },
      fx.rpc
    );
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]).toMatchObject({ chatId: "!dm:server" });
    expect(fx.replies[0].text).toContain("⚠️ 调用失败,正在重试 1/3: 429 too many requests");
  });

  it("auto_retry_start truncates a long upstream error", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    const long = "x".repeat(600);
    fx.router.handleEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: long }, fx.rpc);
    await flush();
    expect(fx.replies[0].text).toContain("正在重试 2/3");
    expect(fx.replies[0].text.length).toBeLessThan(300);
    expect(fx.replies[0].text.endsWith("…")).toBe(true);
  });

  it("auto_retry_start without a bound room is a silent no-op (no crash)", async () => {
    const fx = makeFixtures();
    fx.router.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "boom" }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(0);
  });

  it("auto_retry_end failure notifies with the final error", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent(
      { type: "auto_retry_end", success: false, finalError: "provider unreachable" },
      fx.rpc
    );
    await flush();
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0].text).toContain("❌ 自动重试耗尽: provider unreachable");
  });

  it("a successful retry notifies nothing", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "do work" }));

    fx.router.handleEvent({ type: "auto_retry_end", success: true }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(0);
  });

  it("retry notifications follow the project room's pinned binding", async () => {
    const fx = makeFixtures({ projectRoom: true });
    await fx.router.handleIncoming(makeMsg({ chatId: "!proj:server", content: "do work" }));

    fx.router.handleEvent({ type: "auto_retry_start", attempt: 3, maxAttempts: 5, errorMessage: "timeout" }, fx.rpc);
    fx.router.handleEvent({ type: "auto_retry_end", success: false, finalError: "gone for good" }, fx.rpc);
    await flush();
    expect(fx.replies).toHaveLength(2);
    expect(fx.replies[0]).toMatchObject({ chatId: "!proj:server" });
    expect(fx.replies[0].text).toContain("正在重试 3/5");
    expect(fx.replies[1]).toMatchObject({ chatId: "!proj:server" });
    expect(fx.replies[1].text).toContain("❌ 自动重试耗尽: gone for good");
  });
});
