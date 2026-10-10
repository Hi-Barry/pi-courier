/**
 * /remind command family (issue #117) through the router: REAL
 * store+clock on a temp file with fake timers, delivery wired into the
 * fixture's sendReply — the full loop (command → disk → timer → room) is
 * under test, not a mock of either end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageRouter } from "../src/rpc/message-router";
import { ReminderClock } from "../src/reminders/reminder-clock";
import { ReminderStore, type ReminderEntry } from "../src/reminders/reminder-store";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { JsonStateFile } from "../src/state/json-file";
import { makeMsg, makeRouterFixture } from "./helpers";

const BASE = new Date(2026, 9, 8, 10, 0, 0, 0).getTime();
const MIN = 60_000;

describe("/remind command family (issue #117)", () => {
  let dir: string;
  let file: string;
  let replies: Array<{ chatId: string; transport: string; text: string }>;
  let prompt: ReturnType<typeof vi.fn>;
  let router: MessageRouter;
  let clock: ReminderClock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    dir = mkdtempSync(join(tmpdir(), "pi-courier-remind-router-"));
    file = join(dir, "reminders.json");
    replies = [];
    prompt = vi.fn().mockResolvedValue(undefined);

    const rpc = {
      prompt,
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const sendReply = async (chatId: string, transport: string, text: string) => {
      replies.push({ chatId, transport, text });
    };
    clock = new ReminderClock(
      new ReminderStore(new JsonStateFile<ReminderEntry[]>(file, [])),
      // 与 standalone 的接线同形:deliver 收整个投递对象,这里适配到 sendReply。
      (d) => sendReply(d.chatId, d.transport, d.text)
    );
    router = makeRouterFixture({ rpc, sendReply, extra: { reminders: clock } }).router;
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const lastReply = () => replies.at(-1)!.text;

  it("the happy loop: /remind → confirmation → disk → fire → room delivery, consumed once", async () => {
    await router.handleIncoming(makeMsg({ messageId: "m1", text: "/remind 30m 泡茶" }));
    expect(lastReply()).toContain("已定提醒");
    expect(lastReply()).toContain("泡茶");
    // Persisted before anything can crash.
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30 * MIN);
    // 确认回执与到点投递都含"泡茶",用 to点文案("提醒 @")区分两者。
    const fired = replies.filter((r) => r.text.includes("提醒 @barry"));
    expect(fired).toEqual([{ chatId: "!dm:server", transport: "matrix", text: expect.stringContaining("泡茶") }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
    // And a plain message still goes to pi as a prompt (no command leakage).
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "继续" }));
    expect(prompt).toHaveBeenCalledWith("继续");
  });

  it("usage / invalid time / missing text get helpful replies and store nothing", async () => {
    await router.handleIncoming(makeMsg({ text: "/remind" }));
    expect(lastReply()).toContain("用法");
    await router.handleIncoming(makeMsg({ text: "/remind 30m" }));
    expect(lastReply()).toContain("用法");
    await router.handleIncoming(makeMsg({ text: "/remind tomorrow 记得开会" }));
    expect(lastReply()).toContain("认不出时间");
    expect(lastReply()).toContain("tomorrow");
    await router.handleIncoming(makeMsg({ text: "/remind 0m 不可能零分钟" }));
    expect(lastReply()).toContain("认不出时间");
    // 没有任何成功添加 → 落盘从未发生(文件不存在正是"没存过"的形状)。
    expect(existsSync(file)).toBe(false);
  });

  it("list and rm manage this room's reminders by 序号", async () => {
    await router.handleIncoming(makeMsg({ messageId: "m1", text: "/remind 2h 后面的" }));
    await router.handleIncoming(makeMsg({ messageId: "m2", text: "/remind 30m 先到的" }));
    await router.handleIncoming(makeMsg({ messageId: "m3", text: "/remind list" }));
    expect(lastReply()).toContain("本房间的提醒");
    expect(lastReply()).toContain("1. 2026-10-08 10:30 — 先到的");
    expect(lastReply()).toContain("2. 2026-10-08 12:00 — 后面的");

    await router.handleIncoming(makeMsg({ messageId: "m4", text: "/remind rm 1" }));
    expect(lastReply()).toContain("已取消提醒:先到的");
    await router.handleIncoming(makeMsg({ messageId: "m5", text: "/remind list" }));
    expect(lastReply()).not.toContain("先到的");
    expect(lastReply()).toContain("后面的");

    await router.handleIncoming(makeMsg({ messageId: "m6", text: "/remind rm" }));
    expect(lastReply()).toContain("用法");
    await router.handleIncoming(makeMsg({ messageId: "m7", text: "/remind rm 9" }));
    expect(lastReply()).toContain("没有这个序号");
  });

  it("the room cap (20) is enforced with a refusal", async () => {
    for (let i = 0; i < 20; i++) {
      await router.handleIncoming(makeMsg({ messageId: `m${i}`, text: `/remind ${i + 1}m n${i}` }));
    }
    expect(lastReply()).toContain("已定提醒");
    await router.handleIncoming(makeMsg({ messageId: "m99", text: "/remind 5m 超了" }));
    expect(lastReply()).toContain("上限");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(20);
  });

  it("without the controller injected, /remind says so and nothing is stored", async () => {
    const rpc = {
      prompt,
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
      label: undefined,
      onEvent: vi.fn(),
    } as unknown as PiRpc;
    const bareReplies: Array<{ chatId: string; transport: string; text: string }> = [];
    const { router: bare } = makeRouterFixture({
      rpc,
      sendReply: async (chatId: string, transport: string, text: string) => {
        bareReplies.push({ chatId, transport, text });
      },
    });
    await bare.handleIncoming(makeMsg({ text: "/remind 30m 泡茶" }));
    expect(bareReplies.at(-1)!.text).toContain("未装配");
  });
});
