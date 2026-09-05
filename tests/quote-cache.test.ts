/**
 * Reply-quote ring cache (issue #56 票5): per-room in-memory map of
 * event_id → excerpt with FIFO eviction at 50 entries per room. Pure module —
 * no I/O, no Matrix dependency.
 */
import { describe, expect, it } from "vitest";
import { createQuoteCache, toExcerpt } from "../src/quote-cache";

describe("quote cache", () => {
  it("records and looks up an excerpt by event id within a room", () => {
    const cache = createQuoteCache();
    cache.record("!r:server", "$ev1", { username: "carol", excerpt: "hello there" });
    expect(cache.lookup("!r:server", "$ev1")).toEqual({ username: "carol", excerpt: "hello there" });
  });

  it("returns undefined on a miss (unknown room or event)", () => {
    const cache = createQuoteCache();
    cache.record("!r:server", "$ev1", { username: "carol", excerpt: "hi" });
    expect(cache.lookup("!r:server", "$missing")).toBeUndefined();
    expect(cache.lookup("!other:server", "$ev1")).toBeUndefined();
    expect(cache.lookup("!r:server", "$ev1")).toBeDefined(); // still present after misses
  });

  it("evicts the oldest entry past 50 per room (ring behaviour)", () => {
    const cache = createQuoteCache();
    for (let i = 1; i <= 50; i++) {
      cache.record("!r:server", `$ev${i}`, { username: "u", excerpt: String(i) });
    }
    expect(cache.lookup("!r:server", "$ev1")).toBeDefined();
    cache.record("!r:server", "$ev51", { username: "u", excerpt: "51" });
    expect(cache.lookup("!r:server", "$ev1")).toBeUndefined();
    expect(cache.lookup("!r:server", "$ev2")).toBeDefined();
    expect(cache.lookup("!r:server", "$ev51")).toBeDefined();
  });

  it("re-recording an event id refreshes it without evicting a second slot", () => {
    const cache = createQuoteCache();
    for (let i = 1; i <= 50; i++) {
      cache.record("!r:server", `$ev${i}`, { username: "u", excerpt: String(i) });
    }
    cache.record("!r:server", "$ev1", { username: "u", excerpt: "refreshed" });
    cache.record("!r:server", "$ev51", { username: "u", excerpt: "51" });
    expect(cache.lookup("!r:server", "$ev1")).toEqual({ username: "u", excerpt: "refreshed" });
    // Eviction follows last-seen order: the refreshed $ev1 moved to the end,
    // so $ev2 is now the oldest and falls out instead.
    expect(cache.lookup("!r:server", "$ev2")).toBeUndefined();
    expect(cache.lookup("!r:server", "$ev3")).toBeDefined();
  });

  it("keeps rooms isolated (one room's flood never evicts another's history)", () => {
    const cache = createQuoteCache();
    cache.record("!a:server", "$a1", { username: "u", excerpt: "a1" });
    for (let i = 1; i <= 60; i++) {
      cache.record("!b:server", `$b${i}`, { username: "u", excerpt: String(i) });
    }
    expect(cache.lookup("!a:server", "$a1")).toBeDefined();
    expect(cache.lookup("!b:server", "$b1")).toBeUndefined();
  });
});

describe("toExcerpt (quote extraction and cleanup)", () => {
  it("collapses newlines and whitespace into a single line", () => {
    expect(toExcerpt("line one\nline two\r\n  line three  ")).toBe("line one line two line three");
  });

  it("truncates to 200 chars with an ellipsis marker", () => {
    const long = "字".repeat(300);
    const excerpt = toExcerpt(long);
    expect(excerpt).toBe(`${"字".repeat(200)}…`);
    expect(excerpt.length).toBe(201);
  });

  it("leaves a short clean body untouched", () => {
    expect(toExcerpt("short body")).toBe("short body");
  });
});
