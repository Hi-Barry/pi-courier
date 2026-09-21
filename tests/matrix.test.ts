/**
 * Matrix transport pure functions (spec #99/#101): outbound markdown
 * rendering, the event-skip filter and the group/join-hint predicates —
 * unit-tested in place, no SDK, no Matrix connection. Moved verbatim from
 * the retired matrix-utils.test.ts.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  formatForMatrix,
  isGroupChatRoom,
  shouldPostJoinHint,
  shouldSkipEvent,
} from "../src/transports/matrix.js";

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

  it("lets body-carrying exotic msgtypes through (m.location → router's polite receipt, 票3)", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.location", geo_uri: "geo:0,0", body: "Location" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBeNull();
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

  it("lets payload-less media msgtypes through too (→ polite receipt path, 票3)", () => {
    expect(shouldSkipEvent(makeEvent({ content: { msgtype: "m.image", body: "photo" } }), botUserId, connectedAt, joinedRooms, "!room1:matrix.org"))
      .toBeNull();
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
