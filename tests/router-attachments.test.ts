/**
 * Attachment ledger + prompt injection (issue #66 票1, 接缝2): the highest
 * seam — fake rpc, assert prompt text. The transport is NOT involved here;
 * attachments arrive as ExternalMessage.paths already saved on disk.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedAttachmentEntry } from "../src/rpc/attachment-ledger";
import { attachmentLedgerKey } from "../src/rpc/attachment-ledger";
import { attachmentSavedReply, withAttachmentPrefix } from "../src/rpc/message-router";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { JsonStateFile } from "../src/state/json-file";
import type { MessageAttachment } from "../src/types";
import { makeMsg, makeRouterFixture } from "./helpers";

const ATT: MessageAttachment = {
  path: "/home/u/.pi/pi-courier-attachments/room-1a2b/abc123def456-photo.png",
  filename: "abc123def456-photo.png",
  bytes: 2048,
};

function makeFixtures(opts: { ledger?: JsonStateFile<PersistedAttachmentEntry[]> } = {}) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const prompt = vi.fn().mockResolvedValue(undefined);
  const rpc = {
    prompt,
    getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
    label: undefined,
    onEvent: vi.fn(),
  } as unknown as PiRpc;
  const { router } = makeRouterFixture({
    rpc,
    trusted: ["matrix:@barry:server", "matrix:@carol:server"],
    sendReply: async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    },
    ...(opts.ledger ? { extra: { attachmentsLedger: opts.ledger } } : {}),
  });
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

/**
 * Durable attachment ledger (issue #114): the in-memory Map stays the hot
 * path; the disk file is a backup. Ledger injected → parked attachments
 * survive a router (= service) restart, 24h TTL on load; absent → the
 * pre-#114 behaviour (a restart loses the ledger).
 */
describe("durable attachment ledger (issue #114)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function tempLedger() {
    const dir = mkdtempSync(join(tmpdir(), "pi-courier-ledger-"));
    dirs.push(dir);
    const file = join(dir, "pending-attachments.json");
    return { ledger: new JsonStateFile<PersistedAttachmentEntry[]>(file, []), file };
  }

  it("parked attachments survive a router restart; consumption clears memory and disk", async () => {
    const { ledger, file } = tempLedger();
    const first = makeFixtures({ ledger });
    await first.router.handleIncoming(
      makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT, { ...ATT, path: "/x/second.jpg" }] } })
    );

    // "Restart": a brand-new router over the same ledger file.
    const second = makeFixtures({ ledger });
    await second.router.handleIncoming(makeMsg({ messageId: "m2", text: "看看刚才那张图" }));
    expect(second.prompt).toHaveBeenCalledTimes(1);
    const sent = second.prompt.mock.calls[0]![0] as string;
    expect(sent).toContain(ATT.path);
    expect(sent).toContain("/x/second.jpg");

    // Consumed exactly once → both copies empty afterwards.
    await second.router.handleIncoming(makeMsg({ messageId: "m3", text: "再看看" }));
    expect((second.prompt.mock.calls[1]![0] as string)).not.toContain(ATT.path);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("entries older than the 24h TTL are dropped on load", async () => {
    const { ledger, file } = tempLedger();
    writeFileSync(
      file,
      JSON.stringify([
        { chatId: "!dm:server", userId: "@barry:server", at: Date.now() - 25 * 60 * 60 * 1000, attachments: [ATT] },
      ]),
      "utf8"
    );
    const fx = makeFixtures({ ledger });
    await fx.router.handleIncoming(makeMsg({ messageId: "m1", text: "还在吗" }));
    expect((fx.prompt.mock.calls[0]![0] as string)).not.toContain(ATT.path);
  });

  it("malformed load entries are skipped; per-sender isolation survives the restore", async () => {
    const { ledger, file } = tempLedger();
    writeFileSync(
      file,
      JSON.stringify([
        null,
        { chatId: "!dm:server", userId: "@barry:server", at: Date.now(), attachments: [ATT] },
        { chatId: "!dm:server", userId: "@carol:server", at: Date.now(), attachments: [{ ...ATT, path: "/x/carol.jpg" }] },
        { chatId: "!dm:server", at: Date.now(), attachments: [{ ...ATT, path: "/x/orphan.jpg" }] },
      ]),
      "utf8"
    );
    const fx = makeFixtures({ ledger });
    await fx.router.handleIncoming(makeMsg({ messageId: "m1", text: "看" }));
    const sent = fx.prompt.mock.calls[0]![0] as string;
    expect(sent).toContain(ATT.path);
    expect(sent).not.toContain("/x/carol.jpg"); // carol's park is hers alone
    expect(sent).not.toContain("/x/orphan.jpg"); // userId-less entry skipped
    // The rewrite after barry's consumption leaves only well-formed entries —
    // carol's untouched park persists (per-sender isolation end to end).
    await fx.router.handleIncoming(makeMsg({ messageId: "m2", text: "再看" }));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
      {
        chatId: "!dm:server",
        userId: "@carol:server",
        at: expect.any(Number),
        attachments: [{ bytes: 2048, filename: "abc123def456-photo.png", path: "/x/carol.jpg" }],
      },
    ]);
  });

  it("no ledger injected → pure in-memory behaviour (a restart loses the park)", async () => {
    const first = makeFixtures();
    await first.router.handleIncoming(makeMsg({ messageId: "m1", payload: { kind: "media", saved: [ATT] } }));
    const second = makeFixtures();
    await second.router.handleIncoming(makeMsg({ messageId: "m2", text: "看看" }));
    expect((second.prompt.mock.calls[0]![0] as string)).not.toContain(ATT.path);
  });

  it("purgeRoomAttachments (room-death cleanup) drops only that room's parks", async () => {
    const { ledger, file } = tempLedger();
    const fx = makeFixtures({ ledger });
    await fx.router.handleIncoming(makeMsg({ messageId: "m1", chatId: "!roomA:server", payload: { kind: "media", saved: [ATT] } }));
    await fx.router.handleIncoming(makeMsg({ messageId: "m2", chatId: "!roomB:server", payload: { kind: "media", saved: [{ ...ATT, path: "/x/b.jpg" }] } }));

    expect(fx.router.purgeRoomAttachments("!roomA:server")).toBe(1);
    expect(fx.router.purgeRoomAttachments("!roomA:server")).toBe(0); // idempotent
    // The purge-time rewrite keeps only room B's entry on disk (read BEFORE
    // room B's park gets consumed below).
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as PersistedAttachmentEntry[];
    expect(onDisk.map((e) => e.chatId)).toEqual(["!roomB:server"]);
    // Room A's park is gone; room B's is untouched and still injects.
    await fx.router.handleIncoming(makeMsg({ messageId: "m3", chatId: "!roomA:server", text: "看A" }));
    expect((fx.prompt.mock.calls[0]![0] as string)).not.toContain(ATT.path);
    await fx.router.handleIncoming(makeMsg({ messageId: "m4", chatId: "!roomB:server", text: "看B" }));
    expect((fx.prompt.mock.calls[1]![0] as string)).toContain("/x/b.jpg");
  });
});
