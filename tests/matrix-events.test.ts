/**
 * Matrix event translator (spec #72 票2/C2): unit-tested through its own
 * interface — no SDK, no Matrix connection. Ports are fakes or the real
 * AttachmentStore over a fake MediaSource.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AttachmentStore, type MediaSource } from "../src/transports/attachments.js";
import { createEventTranslator } from "../src/transports/matrix-events.js";
import { createQuoteCache } from "../src/quote-cache.js";
import type { ExternalMessage } from "../src/types";

const ROOM = "!room:server";
const BOT = "@bot:server";

function textEvent(body: string, extra: Record<string, unknown> = {}) {
  return {
    sender: "@alice:server",
    origin_server_ts: Date.now(),
    event_id: "$evt1",
    content: { msgtype: "m.text", body, ...extra },
  };
}

function makeTranslator(overrides: {
  groupChat?: boolean;
  attachments?: AttachmentStore;
  botUserId?: string;
} = {}) {
  const resolveCalls: string[] = [];
  const translator = createEventTranslator({
    transportType: "matrix",
    botUserId: overrides.botUserId ?? BOT,
    quoteCache: createQuoteCache(),
    resolveIsGroupChat: async (roomId) => {
      resolveCalls.push(roomId);
      return overrides.groupChat ?? false;
    },
    ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
  });
  return { translator, resolveCalls };
}

function storeWith(payload: Buffer | Error): AttachmentStore {
  const source: MediaSource = {
    downloadPlaintext: async () => {
      if (payload instanceof Error) throw payload;
      return payload;
    },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mx-events-"));
  return new AttachmentStore({ rootDir: root, maxBytes: 10 * 1024 * 1024 }, source);
}

describe("event translator — text", () => {
  it("translates a DM text message without mention stripping", async () => {
    const { translator } = makeTranslator();
    const { message } = await translator.translate(ROOM, textEvent("你好"));
    expect(message?.payload).toEqual({ kind: "text", text: "你好" });
    expect(message?.username).toBe("alice");
    expect(message?.wasMentioned).toBe(false);
  });

  it("strips the bot mention in group chats and flags wasMentioned", async () => {
    const { translator } = makeTranslator({ groupChat: true });
    const { message } = await translator.translate(ROOM, textEvent(`@bot:server 请看这个`));
    expect(message?.payload.kind === "text" && message.payload.text).toBe("请看这个");
    expect(message?.wasMentioned).toBe(true);
  });

  it("forwards whitespace-only bodies verbatim — trimming stays the router's job (行为零变化)", async () => {
    const { translator } = makeTranslator();
    const { message } = await translator.translate(ROOM, textEvent("  "));
    expect(message?.payload.kind === "text" && message.payload.text).toBe("  ");
  });

  it("records every message and resolves replies against the quote cache", async () => {
    const { translator } = makeTranslator();
    await translator.translate(ROOM, textEvent("被引用的旧消息"));
    const reply = textEvent("这个是什么意思", {
      "m.relates_to": { "m.in_reply_to": { event_id: "$evt1" } },
    });
    (reply as any).event_id = "$evt2";
    const { message } = await translator.translate(ROOM, reply);
    expect(message?.payload.kind === "text" && message.payload.quoted?.excerpt).toContain("被引用的旧消息");
  });
});

describe("event translator — media", () => {
  it("saves via the attachment port and forwards the media payload with an info line", async () => {
    const store = storeWith(Buffer.from("89PNG"));
    const { translator } = makeTranslator({ attachments: store });
    const { message, info } = await translator.translate(ROOM, {
      sender: "@alice:server",
      origin_server_ts: Date.now(),
      event_id: "$img1",
      content: { msgtype: "m.image", body: "photo.png", url: "mxc://s/abc", info: { size: 5 } },
    });
    expect(message?.payload.kind === "media" && message.payload.saved[0]?.filename).toMatch(/photo\.png$/);
    expect(info).toContain("附件已保存");
  });

  it("maps download failures to mediaError with a warn line", async () => {
    const store = storeWith(new Error("M_NOT_FOUND"));
    const { translator } = makeTranslator({ attachments: store });
    const { message, warn } = await translator.translate(ROOM, {
      sender: "@alice:server",
      origin_server_ts: Date.now(),
      event_id: "$img2",
      content: { msgtype: "m.image", body: "gone.png", url: "mxc://s/gone" },
    });
    expect(message?.payload.kind === "mediaError" && message.payload.reason).toContain("M_NOT_FOUND");
    expect(warn).toContain("附件处理失败");
  });

  it("skips media silently when no attachment port is wired (bare transports)", async () => {
    const { translator } = makeTranslator();
    const { message } = await translator.translate(ROOM, {
      sender: "@alice:server",
      origin_server_ts: Date.now(),
      event_id: "$img3",
      content: { msgtype: "m.image", body: "x.png", url: "mxc://s/x" },
    });
    expect(message).toBeUndefined();
  });
});

describe("event translator — unsupported", () => {
  it("forwards unsupported types with the msgtype for the polite receipt", async () => {
    const { translator, resolveCalls } = makeTranslator();
    const { message } = await translator.translate(ROOM, {
      sender: "@alice:server",
      origin_server_ts: Date.now(),
      event_id: "$loc1",
      content: { msgtype: "m.location", geo_uri: "geo:0,0", body: "Location" },
    });
    expect(message?.payload).toEqual({ kind: "unsupported", msgtype: "m.location" });
    expect(resolveCalls).toEqual([ROOM]); // 群/DM 判定经端口完成
  });
});

describe("event translator — envelope", () => {
  it("carries the transport identity and sender fields", async () => {
    const { translator } = makeTranslator();
    const { message } = await translator.translate(ROOM, textEvent("hi"));
    expect((message as ExternalMessage).transport).toBe("matrix");
    expect((message as ExternalMessage).chatId).toBe(ROOM);
    expect((message as ExternalMessage).messageId).toBe("$evt1");
  });
});
