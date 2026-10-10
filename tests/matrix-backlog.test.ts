/**
 * MatrixProvider 离线积压判定(issue #113):经 clientFactory 注入假客户端、
 * 内存台账 fake —— 只钉 transport 的裁决面(谁算积压、谁维持丢弃、replayed
 * 标记与记账时机)。台账自身的磁盘语义在 event-ledger.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixProvider } from "../src/transports/matrix.js";
import type { MatrixClientPort } from "../src/transports/matrix-client.js";
import type { EventLedger } from "../src/transports/event-ledger.js";
import type { ExternalMessage } from "../src/types.js";
import { fakeMatrixClient, type FakeMatrixClient } from "./matrix-fakes.js";

const CFG = { homeserverUrl: "https://matrix.example.org", accessToken: "tok" };
const ROOM = "!room:server";
const ALICE = "@alice:server";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

async function until(predicate: () => boolean) {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error("condition not met yet");
  });
}

function fakeLedger(opts: { freshStart?: boolean; seen?: string[] } = {}): EventLedger & { recorded: string[] } {
  const seenSet = new Set(opts.seen ?? []);
  const recorded: string[] = [];
  return {
    freshStart: opts.freshStart ?? false,
    recorded,
    seen: (id) => seenSet.has(id),
    record: (id) => {
      recorded.push(id);
      seenSet.add(id);
    },
  };
}

function makeProvider(ledger?: EventLedger, mode: "confirm" | "auto" | "off" = "confirm") {
  const clients: FakeMatrixClient[] = [];
  const provider = new MatrixProvider(CFG, () => false, () => {
    const c = fakeMatrixClient();
    clients.push(c);
    return c as unknown as MatrixClientPort;
  });
  provider.setEventLedger(ledger, mode);
  const received: ExternalMessage[] = [];
  provider.onMessage((m) => received.push(m));
  return { provider, client: () => clients[0], received };
}

/** 过期事件:origin_server_ts 早于 connect 时刻 = shouldSkipEvent 判 "stale"。 */
function staleEvent(body: string, eventId = `$evt-${Math.random().toString(36).slice(2)}`) {
  return {
    sender: ALICE,
    origin_server_ts: Date.now() - 60_000,
    event_id: eventId,
    content: { msgtype: "m.text", body },
  };
}

function liveEvent(body: string, eventId = `$evt-${Math.random().toString(36).slice(2)}`) {
  return { ...staleEvent(body, eventId), origin_server_ts: Date.now() };
}

describe("offline backlog classification (issue #113)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stale + unseen + ledger ready → forwarded with replayed=true and recorded", async () => {
    const ledger = fakeLedger();
    const { provider, client, received } = makeProvider(ledger);
    await provider.connect();
    client()!.emit("room.message", ROOM, staleEvent("地铁上发的任务"));
    await until(() => received.length === 1);
    expect(received[0]!.replayed).toBe(true);
    expect(received[0]!.payload).toEqual({ kind: "text", text: "地铁上发的任务" });
    expect(ledger.recorded).toHaveLength(1);
  });

  it("stale + seen → dropped (history replay, behaviour unchanged)", async () => {
    const id = "$already-done";
    const ledger = fakeLedger({ seen: [id] });
    const { provider, client, received } = makeProvider(ledger);
    await provider.connect();
    client()!.emit("room.message", ROOM, staleEvent("重启前处理过的消息", id));
    await flush();
    expect(received).toEqual([]);
  });

  it("freshStart session (first run/upgrade) → stale dropped even if unseen", async () => {
    const ledger = fakeLedger({ freshStart: true });
    const { provider, client, received } = makeProvider(ledger);
    await provider.connect();
    client()!.emit("room.message", ROOM, staleEvent("初始同步回放"));
    await flush();
    expect(received).toEqual([]);
  });

  it("inbox.mode=off → stale dropped (byte-identical to pre-#113)", async () => {
    const ledger = fakeLedger();
    const { provider, client, received } = makeProvider(ledger, "off");
    await provider.connect();
    client()!.emit("room.message", ROOM, staleEvent("off 模式下的积压"));
    await flush();
    expect(received).toEqual([]);
    // off 下 stale 从未「受理」→ 不记账:将来切回 confirm 并重启,这段
    // 窗口里的消息仍会被正确识别成积压(而不是被误判成已处理)。
    expect(ledger.recorded).toHaveLength(0);
  });

  it("no ledger wired (tests/legacy wiring) → stale dropped, status quo", async () => {
    const { provider, client, received } = makeProvider();
    await provider.connect();
    client()!.emit("room.message", ROOM, staleEvent("没有台账的世界"));
    await flush();
    expect(received).toEqual([]);
  });

  it("m.notice silence holds through the backlog path", async () => {
    const ledger = fakeLedger();
    const { provider, client, received } = makeProvider(ledger);
    await provider.connect();
    client()!.emit(
      "room.message",
      ROOM,
      { ...staleEvent("服务通知"), content: { msgtype: "m.notice", body: "bot: restarted" } }
    );
    await flush();
    expect(received).toEqual([]);
  });

  it("live (realtime) events record too — restart replays must not look like backlog", async () => {
    const ledger = fakeLedger();
    const { provider, client, received } = makeProvider(ledger);
    await provider.connect();
    client()!.emit("room.message", ROOM, liveEvent("在线时的普通消息"));
    await until(() => received.length === 1);
    expect(received[0]!.replayed).toBeUndefined();
    expect(ledger.recorded).toHaveLength(1);
  });
});
