/**
 * Matrix event translator (spec #72 票2/C2): unit-tested through its own
 * interface — no SDK, no Matrix connection. Ports are fakes or the real
 * AttachmentStore over a fake MediaSource.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AttachmentStore, type MediaSource } from "../src/transports/attachments.js";
import { createEventTranslator, classifyMessageContent, extractUsername, stripBotMention, wasBotMentioned } from "../src/transports/matrix-events.js";
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

// ─── 纯函数(自 matrix-utils.test.ts 随函数迁入,spec #99/#101)─────────

describe("extractUsername", () => {
  it("extracts localpart from full MXID", () => {
    expect(extractUsername("@alice:matrix.org")).toBe("alice");
  });

  it("handles homeserver with port", () => {
    expect(extractUsername("@bob:localhost:8448")).toBe("bob");
  });

  it("handles already plain username", () => {
    expect(extractUsername("charlie")).toBe("charlie");
  });

  it("handles MXID without @ prefix", () => {
    expect(extractUsername("dave:matrix.org")).toBe("dave");
  });
});

describe("wasBotMentioned", () => {
  const botUserId = "@pibot:matrix.org";

  it("detects full MXID mention", () => {
    expect(wasBotMentioned("hey @pibot:matrix.org do this", botUserId)).toBe(true);
  });

  it("detects @localpart mention (case-insensitive)", () => {
    expect(wasBotMentioned("hey @Pibot do this", botUserId)).toBe(true);
  });

  it("detects lowercase @localpart", () => {
    expect(wasBotMentioned("@pibot help", botUserId)).toBe(true);
  });

  it("returns false when not mentioned", () => {
    expect(wasBotMentioned("hello world", botUserId)).toBe(false);
  });

  it("returns false for bare localpart without @ (avoids false positives on names)", () => {
    // "pibot" appearing in casual chat without @ shouldn't be a mention
    expect(wasBotMentioned("pibot help", botUserId)).toBe(false);
  });

  it("returns false for partial match that isn't the localpart", () => {
    expect(wasBotMentioned("pi is great", botUserId)).toBe(false);
  });
});

describe("stripBotMention", () => {
  const botUserId = "@pibot:matrix.org";

  it("strips full MXID mention", () => {
    expect(stripBotMention("@pibot:matrix.org help me", botUserId)).toBe("help me");
  });

  it("strips multiple mentions", () => {
    expect(stripBotMention("@pibot:matrix.org hey @pibot:matrix.org", botUserId)).toBe("hey");
  });

  it("returns original text when no mention present", () => {
    expect(stripBotMention("hello world", botUserId)).toBe("hello world");
  });

  it("handles mention at end of message", () => {
    expect(stripBotMention("help @pibot:matrix.org", botUserId)).toBe("help");
  });

  it("handles message that is only the mention", () => {
    expect(stripBotMention("@pibot:matrix.org", botUserId)).toBe("");
  });
});

describe("stripBotMention properties", () => {
  it("result never contains the bot MXID (verification)", () => {
    // Generate valid-ish MXIDs: @localpart:server
    const localpart = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/[@: ]/.test(s) && s.length > 0);
    const server = fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/[@: ]/.test(s) && s.length > 0);
    const mxid = fc.tuple(localpart, server).map(([user, host]) => `@${user}:${host}`);

    fc.assert(
      fc.property(mxid, fc.string(), (botId, prefix) => {
        const text = `${prefix} ${botId} some text`;
        const result = stripBotMention(text, botId);
        expect(result).not.toContain(botId);
      })
    );
  });
});

describe("classifyMessageContent", () => {
  it("classifies plain text as text", () => {
    expect(classifyMessageContent({ msgtype: "m.text", body: "hi" })).toEqual({ kind: "text" });
  });

  it("classifies m.image with url as media carrying the mxc url", () => {
    const c = classifyMessageContent({ msgtype: "m.image", body: "photo.png", url: "mxc://s/abc", info: { size: 123 } });
    expect(c).toEqual({ kind: "media", msgtype: "m.image", mxcUrl: "mxc://s/abc", filename: "photo.png", sizeHint: 123 });
  });

  it("prefers the encrypted file block when url and file coexist (票2 裁决)", () => {
    const file = { url: "mxc://s/enc", key: { k: "k" }, iv: "iv", hashes: { sha256: "h" } };
    const c = classifyMessageContent({ msgtype: "m.image", body: "p.png", url: "mxc://s/plain", file });
    expect(c).toMatchObject({ kind: "media", encryptedFile: file });
    expect(c.kind !== "media" || c.mxcUrl === undefined).toBe(true);
  });

  it("classifies every media msgtype as media (票3:m.file/m.audio/m.video)", () => {
    for (const msgtype of ["m.image", "m.file", "m.audio", "m.video"]) {
      const c = classifyMessageContent({ msgtype, body: "x.bin", url: "mxc://s/m" });
      expect(c).toMatchObject({ kind: "media", msgtype });
    }
  });

  it("treats media-shaped content without msgtype as m.sticker (票3:事件类型非 msgtype)", () => {
    const c = classifyMessageContent({ body: "sticker.png", url: "mxc://s/st" });
    expect(c).toMatchObject({ kind: "media", msgtype: "m.sticker" });
  });

  it("classifies media-shaped content with unknown msgtype as other", () => {
    expect(classifyMessageContent({ msgtype: "m.fancy", body: "x", url: "mxc://s/y" })).toEqual({ kind: "other", msgtype: "m.fancy" });
  });

  it("content without a media payload: m.text/m.emote → text, others → other (票3)", () => {
    expect(classifyMessageContent({ msgtype: "m.text", body: "hi" })).toEqual({ kind: "text" });
    expect(classifyMessageContent({ msgtype: "m.emote", body: "waves" })).toEqual({ kind: "text" });
    expect(classifyMessageContent({ msgtype: "m.location", geo_uri: "geo:0,0", body: "Location" })).toEqual({ kind: "other", msgtype: "m.location" });
  });

  it("defaults filename to empty string when body is missing", () => {
    const c = classifyMessageContent({ msgtype: "m.image", url: "mxc://s/abc" });
    expect(c.kind === "media" && c.filename === "").toBe(true);
  });
});
