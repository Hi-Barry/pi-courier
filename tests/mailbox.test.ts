import { describe, expect, it } from "vitest";
import { MAILBOX_MAX_ITEMS, RoomMailbox } from "../src/rpc/mailbox";

describe("RoomMailbox (spec #299 票05)", () => {
  it("drain returns items in arrival order and clears the queue; empty drain is a no-op", () => {
    const box = new RoomMailbox();
    expect(box.drain("!r")).toEqual({ lines: [], dropped: 0 }); // 空仓无副作用
    box.push("!r", "a");
    box.push("!r", "b");
    expect(box.drain("!r")).toEqual({ lines: ["a", "b"], dropped: 0 });
    expect(box.drain("!r")).toEqual({ lines: [], dropped: 0 }); // 已清空
  });

  it("cap: over-limit drops the OLDEST and counts them", () => {
    const box = new RoomMailbox();
    const total = MAILBOX_MAX_ITEMS + 5;
    for (let i = 1; i <= total; i += 1) box.push("!r", `m${i}`);
    const out = box.drain("!r");
    expect(out.lines).toHaveLength(MAILBOX_MAX_ITEMS);
    expect(out.lines[0]).toBe("m6"); // 最旧的 5 条被丢
    expect(out.lines.at(-1)).toBe(`m${total}`);
    expect(out.dropped).toBe(5);
  });

  it("overlong single items are truncated, not dropped", () => {
    const box = new RoomMailbox();
    box.push("!r", "x".repeat(1000));
    const out = box.drain("!r");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]!.length).toBeLessThan(1000);
    expect(out.lines[0]!.endsWith("…")).toBe(true);
    expect(out.dropped).toBe(0);
  });

  it("queues are per-room", () => {
    const box = new RoomMailbox();
    box.push("!a", "a1");
    box.push("!b", "b1");
    expect(box.drain("!a")).toEqual({ lines: ["a1"], dropped: 0 });
    expect(box.drain("!b")).toEqual({ lines: ["b1"], dropped: 0 });
  });
});
