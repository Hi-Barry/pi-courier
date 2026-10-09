/**
 * ReminderClock (issue #117): fake-timer tests over a REAL JsonStateFile on a
 * temp dir, so "disk is the truth, the timer is just a handle" is exercised
 * end to end — including the crash-restart path (a brand-new clock over the
 * same file must re-arm everything and catch up late ones with a note).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderClock, type ReminderDelivery } from "../src/reminders/reminder-clock";
import { ReminderStore, type ReminderEntry } from "../src/reminders/reminder-store";
import { JsonStateFile } from "../src/state/json-file";

const BASE = new Date(2026, 9, 8, 10, 0, 0, 0).getTime();
const MIN = 60_000;
const DAY = 86_400_000;

function entry(partial: Partial<ReminderEntry> & { chatId: string; text: string; dueAt: number }): ReminderEntry {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2, 10),
    transport: "matrix",
    userId: "matrix:@barry:server",
    username: "barry",
    createdAt: partial.createdAt ?? BASE,
    ...partial,
  } as ReminderEntry;
}

describe("ReminderClock (issue #117)", () => {
  let dir: string;
  let file: string;
  let delivered: ReminderDelivery[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    dir = mkdtempSync(join(tmpdir(), "pi-courier-reminders-"));
    file = join(dir, "reminders.json");
    delivered = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeClock = (lateCap?: number) => {
    const store = new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, []));
    const clock = new ReminderClock(store, (d) => {
      delivered.push(d);
    }, lateCap !== undefined ? { lateCap } : {});
    return { store, clock };
  };

  it("a reminder fires once at its due time, is delivered, and leaves the store", async () => {
    const { clock } = makeClock();
    await clock.start();
    expect(clock.add({ chatId: "!r:s", transport: "matrix", userId: "matrix:@barry:server", username: "barry", text: "泡茶", dueAt: BASE + 30 * MIN })).toBe(true);
    expect(delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(delivered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MIN);
    expect(delivered).toEqual([{ chatId: "!r:s", transport: "matrix", text: expect.stringContaining("泡茶") }]);
    expect(delivered[0]!.text).toContain("@barry");
    // Consumed exactly once: the file is empty now.
    expect(new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, [])).list()).toEqual([]);
  });

  it("multiple reminders fire in due order and each is removed after delivery", async () => {
    const { clock, store } = makeClock();
    await clock.start();
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "second", dueAt: BASE + 20 * MIN });
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "first", dueAt: BASE + 10 * MIN });
    expect(store.list().map((e) => e.text)).toEqual(["first", "second"]);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(delivered.map((d) => d.text)).toEqual([expect.stringContaining("first")]);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(delivered.map((d) => d.text)).toEqual([expect.stringContaining("first"), expect.stringContaining("second")]);
  });

  it("restart re-arms future reminders and catches up overdue ones with a late note", async () => {
    // First life: one reminder 30 minutes out.
    const first = makeClock();
    await first.clock.start();
    first.clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "取件", dueAt: BASE + 30 * MIN });
    first.clock.stop();

    // Crash: the process dies for 2 hours (fake clock jumps).
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);

    // Second life over the same file: the overdue reminder is delivered at
    // once, noted as late; nothing fires twice.
    const second = makeClock();
    await second.clock.start();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("取件");
    expect(delivered[0]!.text).toContain("迟到 90 分钟");
    // The store no longer holds it (a later restart won't re-deliver).
    expect(new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, [])).list()).toEqual([]);
  });

  it("startup catch-up delivers at most lateCap overdue and summarizes the rest per room", async () => {
    // Seed the file directly: the room cap (20) blocks add() long before 55,
    // but a hand-edited/pre-cap file can hold more — the catch-up cap exists
    // exactly for that defense-in-depth case.
    const seeded: ReminderEntry[] = [];
    for (let i = 0; i < 55; i++) {
      seeded.push(entry({ chatId: "!a:s", text: `a${i}`, dueAt: BASE - (i + 1) * MIN, id: `a${i}` }));
    }
    // b 房三条排在最前(dueAt 最早),确保进入补投范围而非被 cap 丢弃。
    for (let i = 0; i < 3; i++) {
      seeded.push(entry({ chatId: "!b:s", text: `b${i}`, dueAt: BASE - 200 * MIN - i * MIN, id: `b${i}` }));
    }
    writeFileSync(file, JSON.stringify(seeded), "utf8");

    const { clock } = makeClock(50);
    await clock.start();
    const aReminders = delivered.filter((d) => d.chatId === "!a:s" && !d.text.includes("静默丢弃"));
    const aDeliveries = delivered.filter((d) => d.chatId === "!a:s"); // 47 条提醒 + 1 条汇总
    const bDeliveries = delivered.filter((d) => d.chatId === "!b:s");
    expect(aReminders).toHaveLength(47);
    expect(aDeliveries).toHaveLength(48);
    expect(bDeliveries).toHaveLength(3);
    // One drop summary per over-cap room, never per dropped reminder.
    const summaries = delivered.filter((d) => d.text.includes("静默丢弃"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.chatId).toBe("!a:s");
    expect(summaries[0]!.text).toContain("8");
    // Nothing left on disk after the catch-up.
    expect(new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, [])).list()).toEqual([]);
  });

  it("a lead longer than Node's setTimeout ceiling still fires exactly on time (chunked arm)", async () => {
    const { clock } = makeClock();
    await clock.start();
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "远期", dueAt: BASE + 40 * DAY });

    // March to the ceiling boundary — nothing may fire early.
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(delivered).toHaveLength(0);
    // Remainder (~15.2 days): now it fires, with no late note.
    await vi.advanceTimersByTimeAsync(40 * DAY);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).not.toContain("迟到");
  });

  it("room cap: the 21st reminder in a room is refused, other rooms unaffected", async () => {
    const { clock } = makeClock();
    await clock.start();
    for (let i = 0; i < 20; i++) {
      expect(clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: `n${i}`, dueAt: BASE + (i + 1) * MIN })).toBe(true);
    }
    expect(clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "over", dueAt: BASE + 30 * MIN })).toBe(false);
    expect(clock.add({ chatId: "!other:s", transport: "matrix", userId: "u", username: "barry", text: "fine", dueAt: BASE + 30 * MIN })).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it("removeByIndex works on the room's 1-based due order", async () => {
    const { clock, store } = makeClock();
    await clock.start();
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "later", dueAt: BASE + 2 * 60 * MIN });
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "sooner", dueAt: BASE + MIN });
    expect(clock.removeByIndex("!r:s", 2)?.text).toBe("later");
    expect(clock.removeByIndex("!r:s", 5)).toBeUndefined();
    expect(store.listForRoom("!r:s")).toHaveLength(1);
  });

  it("purgeRoom drops only that room's reminders, persists, and the other rooms keep firing", async () => {
    const { clock } = makeClock();
    await clock.start();
    clock.add({ chatId: "!a:s", transport: "matrix", userId: "u", username: "barry", text: "a-one", dueAt: BASE + MIN });
    clock.add({ chatId: "!a:s", transport: "matrix", userId: "u", username: "barry", text: "a-two", dueAt: BASE + 2 * MIN });
    clock.add({ chatId: "!b:s", transport: "matrix", userId: "u", username: "barry", text: "b-live", dueAt: BASE + MIN });

    expect(clock.purgeRoom("!a:s")).toBe(2);
    expect(clock.purgeRoom("!a:s")).toBe(0); // idempotent
    // Room B's reminder is untouched and still fires on time.
    await vi.advanceTimersByTimeAsync(MIN + 5_000);
    expect(delivered.map((d) => d.chatId)).toEqual(["!b:s"]);
    expect(new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, [])).listForRoom("!a:s")).toEqual([]);
  });

  it("stop() disarms the timer: nothing fires afterwards", async () => {
    const { clock } = makeClock();
    await clock.start();
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "never", dueAt: BASE + MIN });
    clock.stop();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(delivered).toHaveLength(0);
  });

  it("on-time delivery carries no late note (small timer drift tolerated)", async () => {
    const { clock } = makeClock();
    await clock.start();
    clock.add({ chatId: "!r:s", transport: "matrix", userId: "u", username: "barry", text: "准点", dueAt: BASE + MIN });
    // 3 seconds of drift — below the 60s late threshold.
    await vi.advanceTimersByTimeAsync(MIN + 3_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).not.toContain("迟到");
    expect(readFileSync(file, "utf8")).toBe("[]");
  });
});
