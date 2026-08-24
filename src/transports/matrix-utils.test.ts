import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  extractUsername,
  formatForMatrix,
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

// Excluded from testing (design decisions / integration-only, verified by inspection):
// - connect()/disconnect() lifecycle (requires real MatrixClient)
// - sendMessage()/sendTyping() (thin SDK wrappers)
// - index.ts wiring (env var reading, command handler plumbing)
// - Widget abbreviation (mx)
