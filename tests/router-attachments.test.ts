/**
 * Attachment ledger + prompt injection (issue #66 票1, 接缝2): the highest
 * seam — fake rpc, assert prompt text. The transport is NOT involved here;
 * attachments arrive as ExternalMessage.paths already saved on disk.
 */
import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import {
  attachmentLedgerKey,
  attachmentSavedReply,
  createMessageRouter,
  withAttachmentPrefix,
} from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage, MessageAttachment } from "../src/types";

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

const ATT: MessageAttachment = {
  path: "/home/u/.pi/pi-courier-attachments/room-1a2b/abc123def456-photo.png",
  filename: "abc123def456-photo.png",
  bytes: 2048,
};

function makeFixtures() {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const prompt = vi.fn().mockResolvedValue(undefined);
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
  const store = new ConfigStore({});
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", "matrix:@carol:server"],
    adminUserId: "matrix:@barry:server",
    channels: {},
  });
  const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping: vi.fn(), roomOps, store, pmctl });
  return { router, prompt, replies, lastReply: () => replies.at(-1)!.text };
}

describe("attachment ledger (issue #66 票1)", () => {
  it("an attachment message is NOT prompted — it parks in the ledger and answers with a receipt", async () => {
    const { router, prompt, lastReply } = makeFixtures();
    await router.handleIncoming(makeMsg({ payload: { kind: "media", saved: [ATT] } }));
    expect(prompt).not.toHaveBeenCalled();
    expect(lastReply()).toContain(ATT.path);
    expect(lastReply()).toContain("📎");
  });

  it("the next conversational message carries the attachment path and clears the ledger", async () => {
    const { router, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ text: "这张图里是什么" }));
    expect(prompt).toHaveBeenCalledTimes(1);
    const sent = prompt.mock.calls[0]![0] as string;
    expect(sent).toContain("read 工具查看");
    expect(sent).toContain(ATT.path);
    expect(sent.endsWith("这张图里是什么")).toBe(true);
  });

  it("a second attachment message queues; one text message carries BOTH paths in arrival order", async () => {
    const { router, prompt } = makeFixtures();
    const att2 = { ...ATT, path: "/x/second.jpg" };
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ messageId: "m2", payload: { kind: "media", saved: [att2] } }));
    await router.handleIncoming(makeMsg({ messageId: "m3", text: "看看这两张" }));
    const sent = prompt.mock.calls[0]![0] as string;
    expect(sent.indexOf(ATT.path)).toBeLessThan(sent.indexOf(att2.path));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("the ledger consumes exactly once — a following message prompts without the prefix", async () => {
    const { router, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "第一条" }));
    await router.handleIncoming(makeMsg({ messageId: "m3", text: "第二条" }));
    expect((prompt.mock.calls[0]![0] as string)).toContain(ATT.path);
    expect((prompt.mock.calls[1]![0] as string)).not.toContain(ATT.path);
  });

  it("management commands do NOT consume the ledger", async () => {
    const { router, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "/multiproject" }));
    await router.handleIncoming(makeMsg({ messageId: "m3", text: "现在看" }));
    const sent = prompt.mock.calls[0]![0] as string;
    expect(sent).toContain(ATT.path);
  });

  it("unauthorized senders get neither receipt nor ledger entry", async () => {
    const { router, prompt, replies } = makeFixtures();
    // Group chat that was never /enable'd — authorization fails without
    // side effects (a DM stranger would trigger a challenge flow instead).
    await router.handleIncoming(makeMsg({ isGroupChat: true, chatId: "!group:server", userId: "@stranger:server", username: "stranger", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ isGroupChat: true, chatId: "!group:server", userId: "@stranger:server", username: "stranger", text: "看" }));
    expect(replies).toHaveLength(0);
    // barry's own later message must NOT carry the stranger's attachment
    await router.handleIncoming(makeMsg({ text: "看" }));
    expect((prompt.mock.calls[0]![0] as string)).not.toContain(ATT.path);
  });

  it("ledgers are isolated per sender in the same room", async () => {
    const { router, prompt } = makeFixtures();
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ messageId: "m2", userId: "@carol:server", username: "carol", text: "我在说话" }));
    expect((prompt.mock.calls[0]![0] as string)).not.toContain(ATT.path);
  });

  it("attachment failures reach the room verbatim and never enter the ledger", async () => {
    const { router, prompt, lastReply } = makeFixtures();
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "mediaError", reason: "附件过大(11.0 MB > 上限 10.0 MB),未保存" } }));
    expect(lastReply()).toContain("❌ 附件过大");
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "继续" }));
    expect((prompt.mock.calls[0]![0] as string)).not.toContain("附件过大");
  });

  it("a FAILED prompt does not consume the ledger — the retry carries the attachments", async () => {
    const { router, prompt } = makeFixtures();
    prompt.mockRejectedValueOnce(new Error("No API key found"));
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "第一次(发送失败)" }));
    await router.handleIncoming(makeMsg({ messageId: "m3", text: "重试" }));
    expect((prompt.mock.calls[0]![0] as string)).toContain(ATT.path);
    expect((prompt.mock.calls[1]![0] as string)).toContain(ATT.path);
  });

  it("unsupported message types get a polite reply and never prompt (票3)", async () => {
    const { router, prompt, lastReply } = makeFixtures();
    await router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "unsupported", msgtype: "m.location" } }));
    expect(lastReply()).toContain("暂不支持的消息类型(m.location)");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("unsupported-type replies respect authorization (票3)", async () => {
    const { router, replies } = makeFixtures();
    await router.handleIncoming(makeMsg({
      isGroupChat: true, chatId: "!group:server",
      userId: "@stranger:server", username: "stranger",
      payload: { kind: "unsupported", msgtype: "m.location" },
    }));
    expect(replies).toHaveLength(0);
  });
});

describe("attachment prompt prefix (issue #66 票1)", () => {
  it("withAttachmentPrefix is a no-op without attachments", () => {
    expect(withAttachmentPrefix("hello", undefined)).toBe("hello");
    expect(withAttachmentPrefix("hello", [])).toBe("hello");
  });

  it("withAttachmentPrefix puts the path block before the original text", () => {
    const out = withAttachmentPrefix("这是什么", [ATT]);
    expect(out.indexOf(ATT.path)).toBeLessThan(out.indexOf("这是什么"));
    expect(out).toContain("read 工具查看");
  });

  it("receipt text names the path and a human size", () => {
    expect(attachmentSavedReply(ATT)).toContain(ATT.path);
    expect(attachmentSavedReply(ATT)).toContain("2 KB");
  });

  it("ledger key separates room and sender", () => {
    expect(attachmentLedgerKey("!r:s", "@a:s")).not.toBe(attachmentLedgerKey("!r:s", "@b:s"));
    expect(attachmentLedgerKey("!r:s", "@a:s")).not.toBe(attachmentLedgerKey("!r2:s", "@a:s"));
  });
});
