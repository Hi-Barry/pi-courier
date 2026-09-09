import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyMessageContent,
  extractUsername,
  formatForMatrix,
  isGroupChatRoom,
  sanitizeMediaFilename,
  shouldPostJoinHint,
  shouldSkipEvent,
  stripBotMention,
  wasBotMentioned,
} from "./matrix-utils.js";

// ─── formatForMatrix ──────────────────────────────────────────

describe("formatForMatrix", () => {
  it("renders plain text as a paragraph, body preserved", () => {
    const result = formatForMatrix("hello world");
    expect(result.body).toBe("hello world");
    expect(result.formattedBody).toContain("hello world");
  });

  it("converts **bold** to <strong>", () => {
    const result = formatForMatrix("this is **bold** text");
    expect(result.body).toBe("this is **bold** text");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
  });

  it("converts *italic* to <em>", () => {
    const result = formatForMatrix("this is *italic* text");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("does not confuse **bold** with *italic*", () => {
    const result = formatForMatrix("**bold** and *italic*");
    expect(result.formattedBody).toContain("<strong>bold</strong>");
    expect(result.formattedBody).toContain("<em>italic</em>");
  });

  it("converts [text](url) to <a href>", () => {
    const result = formatForMatrix("click [here](https://example.com)");
    expect(result.formattedBody).toContain('<a href="https://example.com">here</a>');
  });

  it("converts newlines to <br>", () => {
    const result = formatForMatrix("line *one*\nline two");
    expect(result.formattedBody).toContain("<br>");
  });

  it("protects inline code from markdown conversion", () => {
    const result = formatForMatrix("use `**not bold**` here");
    expect(result.formattedBody).toContain("<code>");
    expect(result.formattedBody).not.toContain("<strong>not bold</strong>");
  });

  it("protects code blocks from markdown conversion", () => {
    const result = formatForMatrix("```\n**not bold**\n```");
    expect(result.formattedBody).toContain("<pre><code>");
    expect(result.formattedBody).not.toContain("<strong>");
  });

  it("adds language class to code blocks", () => {
    const result = formatForMatrix("```typescript\nconst x = 1;\n```");
    expect(result.formattedBody).toContain('class="language-typescript"');
  });

  it("escapes HTML inside code blocks", () => {
    const result = formatForMatrix("```\n<script>alert('xss')</script>\n```");
    expect(result.formattedBody).toContain("&lt;script&gt;");
    expect(result.formattedBody).not.toContain("<script>");
  });

  it("escapes HTML inside inline code", () => {
    const result = formatForMatrix("use `<div>` tag");
    expect(result.formattedBody).toContain("&lt;div&gt;");
  });

  it("preserves original text as body even when formatted", () => {
    const original = "**bold** and `code`";
    const result = formatForMatrix(original);
    expect(result.body).toBe(original);
  });

  it("escapes raw HTML outside code (html:false)", () => {
    const result = formatForMatrix("hello <script>alert(1)</script>");
    expect(result.formattedBody).not.toContain("<script>");
    expect(result.formattedBody).toContain("&lt;script&gt;");
  });

  it("renders markdown lists (new via markdown-it)", () => {
    const result = formatForMatrix("- a\n- b");
    expect(result.formattedBody).toContain("<ul>");
    expect(result.formattedBody).toContain("<li>a</li>");
  });
});

// ─── shouldSkipEvent ──────────────────────────────────────────

describe("shouldSkipEvent", () => {
  const botUserId = "@bot:matrix.org";
  const connectedAt = 1000;
  const joinedRooms = new Set(["!room1:matrix.org", "!room2:matrix.org"]);

  function makeEvent(overrides: Record<string, any> = {}) {
    return {
      sender: "@user:matrix.org",
      origin_server_ts: 2000,
      content: { msgtype: "m.text", body: "hello" },
      ...overrides,
    };
  }

  it("returns null for a valid message", () => {
    expect(shouldSkipEvent(makeEvent(), botUserId, connectedAt, joinedRooms, "!room1:matrix.org")).toBeNull();
  });

  it("skips own messages", () => {
    expect(shouldSkipEvent(makeEvent({ sender: botUserId }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("own_message");
  });

  it("skips stale events (before connectedAt)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 500 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });

  it("skips events at exactly connectedAt (boundary: < not <=)", () => {
    // connectedAt=1000, event ts=1000 → NOT stale (< is strict)
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 1000 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBeNull();
  });

  it("skips events with ts=999 (one below connectedAt)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: 999 }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });

  it("skips non-text messages", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.location", geo_uri: "geo:0,0" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("lets media events through (m.image with url) — attachment path handles them (#67)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.image", body: "photo.png", url: "mxc://server/abc123" } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBeNull();
  });

  it("lets encrypted media events through (m.image with file block)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.image", body: "photo.png", file: { url: "mxc://server/enc1", key: { k: "x" }, iv: "y", hashes: { sha256: "z" } } } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBeNull();
  });

  it("skips m.notice silently (the ONE deliberate silence — bot-loop guard)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.notice", body: "* bot does things" } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBe("notice");
  });

  it("lets m.emote through as text (票3:emote body 是可读文本)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.emote", body: "waves hello" } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBeNull();
  });

  it("still skips m.image without any media payload", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.image", body: "photo" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips messages with no content", () => {
    expect(shouldSkipEvent(makeEvent({ content: undefined }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips messages with no body", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.text" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("not_text");
  });

  it("skips edits (m.new_content present)", () => {
    expect(shouldSkipEvent(
      makeEvent({ content: { msgtype: "m.text", body: "edited", "m.new_content": { body: "new" } } }),
      botUserId, connectedAt, joinedRooms, "!room1:matrix.org"
    )).toBe("edit");
  });

  it("skips events from rooms not in joinedRooms", () => {
    expect(shouldSkipEvent(makeEvent(), botUserId, connectedAt, joinedRooms, "!unknown:matrix.org"))
      .toBe("not_joined");
  });

  it("handles missing origin_server_ts (defaults to 0, always stale)", () => {
    expect(shouldSkipEvent(makeEvent({ origin_server_ts: undefined }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBe("stale");
  });
});

// ─── extractUsername ──────────────────────────────────────────

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

// ─── wasBotMentioned ─────────────────────────────────────────

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

// ─── stripBotMention ─────────────────────────────────────────

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

// ─── Property tests ───────────────────────────────────────────

describe("formatForMatrix properties", () => {
  it("body always equals original input (preservation)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = formatForMatrix(text);
        expect(result.body).toBe(text);
      })
    );
  });

  it("formattedBody never contains raw <script> tags (html:false, security)", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = formatForMatrix(text);
        expect(result.formattedBody?.toLowerCase()).not.toContain("<script");
      })
    );
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

// ─── isGroupChatRoom ──────────────────────────────────────────

describe("isGroupChatRoom", () => {
  it("classifies >2 members as a group chat", () => {
    expect(isGroupChatRoom(3)).toBe(true);
    expect(isGroupChatRoom(40)).toBe(true);
  });
  it("classifies 2 members (bot + 1 other) as a DM", () => {
    expect(isGroupChatRoom(2)).toBe(false);
  });
  it("classifies the 1-member edge as a DM (not a group)", () => {
    expect(isGroupChatRoom(1)).toBe(false);
  });
});

// ─── shouldPostJoinHint ──────────────────────────────────────

describe("shouldPostJoinHint", () => {
  it("posts the hint for a multi-user, not-yet-enabled room", () => {
    expect(shouldPostJoinHint(5, false)).toBe(true);
  });
  it("does not post the hint for an enabled multi-user room", () => {
    expect(shouldPostJoinHint(5, true)).toBe(false);
  });
  it("does not post the hint for a DM (<=2 members) even when disabled", () => {
    expect(shouldPostJoinHint(2, false)).toBe(false);
  });
  it("does not post the hint for a lone bot room (1 member)", () => {
    expect(shouldPostJoinHint(1, false)).toBe(false);
  });
});

// Excluded from testing (design decisions / integration-only, verified by inspection):
// - connect()/disconnect() lifecycle (requires real MatrixClient)
// - sendMessage()/sendTyping() (thin SDK wrappers)
// - index.ts wiring (env var reading, command handler plumbing)
// - Widget abbreviation (mx)

// ─── 附件分类与文件名消毒(issue #66 票1,接缝1)──────────────────

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

  it("content without a media payload is classified as text (the filter blocks non-text upstream)", () => {
    // m.location 无 url/file → 不是媒体载荷;shouldSkipEvent 已把它挡在
    // not_text(票1 行为),分类只对已通过过滤器的内容负责。
    expect(classifyMessageContent({ msgtype: "m.location", geo_uri: "geo:0,0" })).toEqual({ kind: "text" });
  });

  it("defaults filename to empty string when body is missing", () => {
    const c = classifyMessageContent({ msgtype: "m.image", url: "mxc://s/abc" });
    expect(c.kind === "media" && c.filename === "").toBe(true);
  });
});

describe("sanitizeMediaFilename", () => {
  it("prefixes a deterministic hash of the mxc url", () => {
    expect(sanitizeMediaFilename("photo.png", "mxc://s/abc"))
      .toBe(sanitizeMediaFilename("photo.png", "mxc://s/abc"));
    expect(sanitizeMediaFilename("a.png", "mxc://s/1")).not.toBe(sanitizeMediaFilename("a.png", "mxc://s/2"));
  });

  it("strips path traversal components", () => {
    const name = sanitizeMediaFilename("../../etc/passwd", "mxc://s/abc");
    expect(name).not.toContain("..");
    expect(name).not.toContain("/");
    expect(name.endsWith("passwd")).toBe(true);
  });

  it("strips windows separators and control characters", () => {
    const name = sanitizeMediaFilename("..\\..\\x\u0000y\r\n z.png", "mxc://s/abc");
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("never starts with dots (hidden file / relative-path tricks)", () => {
    expect(sanitizeMediaFilename("..hidden", "mxc://s/abc").endsWith("hidden")).toBe(true);
    expect(sanitizeMediaFilename("..", "mxc://s/abc")).not.toContain("..");
  });

  it("falls back to 'file' when nothing safe remains", () => {
    expect(sanitizeMediaFilename("", "mxc://s/abc")).toMatch(/^[0-9a-f]{12}-file$/);
    expect(sanitizeMediaFilename(undefined, "mxc://s/abc")).toMatch(/^[0-9a-f]{12}-file$/);
  });

  it("property: output is safe for any input (no separators, no traversal, non-empty)", () => {
    const mxc = fc.constant("mxc://server/mediaId");
    const arbBody = fc.string({ maxLength: 300 });
    fc.assert(
      fc.property(arbBody, mxc, (body, url) => {
        const name = sanitizeMediaFilename(body, url);
        expect(name.length).toBeGreaterThan(0);
        expect(name).not.toMatch(/[/\\]/);
        expect(name).not.toContain("..");
        expect(name).toMatch(/^[0-9a-f]{12}-/);
      })
    );
  });
});
