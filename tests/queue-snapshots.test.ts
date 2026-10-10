/**
 * Queue snapshot store + startup consumption (issue #115 stage 2): the disk
 * half of the queue mirror. Contract under test: replace-or-insert per room,
 * an empty snapshot means removal, malformed entries never surface, and
 * consumption is send-once-then-clear with per-room send failures tolerated
 * (the snapshot is a report of a dead process, not a delivery promise).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../src/logger";
import { consumeQueueSnapshots, type QueueSnapshotEntry, QueueSnapshotStore } from "../src/rpc/queue-snapshots";
import { JsonStateFile } from "../src/state/json-file";

const snapshot = (steering: string[], followUp: string[] = []) => ({ steering, followUp });

describe("QueueSnapshotStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const fresh = (): { store: QueueSnapshotStore; file: string } => {
    dir = mkdtempSync(join(tmpdir(), "pi-courier-qsnap-"));
    const file = join(dir, "queue-snapshots.json");
    return { store: new QueueSnapshotStore(new JsonStateFile(file, [])), file };
  };

  it("save → loadValid round-trips the entry (roomId, at, snapshot)", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["排队一"], ["排队二"]));
    const entries = store.loadValid();
    expect(entries).toHaveLength(1);
    expect(entries[0].roomId).toBe("!a:s");
    expect(entries[0].snapshot).toEqual(snapshot(["排队一"], ["排队二"]));
    expect(typeof entries[0].at).toBe("number");
  });

  it("a second save for the same room replaces, never duplicates", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["旧消息"]));
    store.save("!a:s", snapshot(["新消息"]));
    const entries = store.loadValid();
    expect(entries).toHaveLength(1);
    expect(entries[0].snapshot.steering).toEqual(["新消息"]);
  });

  it("entries for different rooms coexist", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["甲"]));
    store.save("!b:s", snapshot(["乙"]));
    expect(store.loadValid().map((e) => e.roomId).sort()).toEqual(["!a:s", "!b:s"]);
  });

  it("saving an empty snapshot removes the entry (nothing left to report)", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["排队一"]));
    store.save("!a:s", snapshot([], []));
    expect(store.loadValid()).toEqual([]);
  });

  it("remove() on a room with no entry never touches disk (no churn, no file)", () => {
    const { store, file } = fresh();
    store.remove("!ghost:s");
    expect(existsSync(file)).toBe(false);
  });

  it("remove() drops exactly the target room", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["甲"]));
    store.save("!b:s", snapshot(["乙"]));
    store.remove("!a:s");
    expect(store.loadValid().map((e) => e.roomId)).toEqual(["!b:s"]);
  });

  it("clear() wipes everything (consume-once support)", () => {
    const { store } = fresh();
    store.save("!a:s", snapshot(["甲"]));
    store.save("!b:s", snapshot(["乙"]));
    store.clear();
    expect(store.loadValid()).toEqual([]);
  });

  it("a corrupt file degrades to no entries (never throws)", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { store, file } = fresh();
    writeFileSync(file, "{not json", "utf8");
    expect(store.loadValid()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("malformed entries are filtered; the valid one survives", () => {
    const { store, file } = fresh();
    store.save("!ok:s", snapshot(["好消息"]));
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    const junk = [
      null,
      42,
      { roomId: "", at: 1, snapshot: snapshot(["x"]) }, // empty roomId
      { roomId: "!x:s", snapshot: snapshot(["x"]) }, // missing at
      { roomId: "!x:s", at: 1, snapshot: { steering: "nope", followUp: [] } }, // bad shape
      { roomId: "!x:s", at: 1, snapshot: snapshot([], []) }, // empty snapshot
    ];
    writeFileSync(file, JSON.stringify([...junk, ...raw]), "utf8");
    const entries = store.loadValid();
    expect(entries).toHaveLength(1);
    expect(entries[0].roomId).toBe("!ok:s");
  });
});

describe("consumeQueueSnapshots (startup consumption)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const seeded = (entries: Array<{ roomId: string; steering: string[] }>): QueueSnapshotStore => {
    dir = mkdtempSync(join(tmpdir(), "pi-courier-qsnap-consume-"));
    const file = join(dir, "queue-snapshots.json");
    mkdirSync(dir, { recursive: true });
    const store = new QueueSnapshotStore(new JsonStateFile(file, []));
    for (const entry of entries) store.save(entry.roomId, snapshot(entry.steering));
    return store;
  };

  it("sends one service-restart notice per project room, then clears the store", async () => {
    const store = seeded([
      { roomId: "!a:s", steering: ["先查日志", "再重启"] },
      { roomId: "!b:s", steering: ["乙房间的队列"] },
    ]);
    const sends: Array<{ roomId: string; text: string }> = [];
    const sent = await consumeQueueSnapshots(store, {
      isProjectRoom: (roomId) => roomId === "!a:s" || roomId === "!b:s",
      send: async (roomId, text) => {
        sends.push({ roomId, text });
      },
    });
    expect(sent).toBe(2);
    expect(sends[0].text).toContain("服务重启");
    expect(sends[0].text).toContain("2 条消息未执行");
    expect(sends[0].text).toContain("先查日志");
    expect(sends[1].roomId).toBe("!b:s");
    expect(store.loadValid()).toEqual([]); // consume-once: file wiped
  });

  it("entries for non-project rooms are dropped, never delivered", async () => {
    const store = seeded([{ roomId: "!gone:s", steering: ["已删项目的队列"] }]);
    const send = vi.fn().mockResolvedValue(undefined);
    const sent = await consumeQueueSnapshots(store, { isProjectRoom: () => false, send });
    expect(sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(store.loadValid()).toEqual([]); // dropped with the rest
  });

  it("a per-room send failure warns and drops that entry; other rooms still notify", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const store = seeded([
      { roomId: "!dead:s", steering: ["投不出去的"] },
      { roomId: "!live:s", steering: ["能投出去的"] },
    ]);
    const sends: string[] = [];
    const sent = await consumeQueueSnapshots(store, {
      isProjectRoom: () => true,
      send: async (roomId) => {
        if (roomId === "!dead:s") throw new Error("M_NOT_FOUND: Room not found");
        sends.push(roomId);
      },
    });
    expect(sent).toBe(1);
    expect(sends).toEqual(["!live:s"]);
    expect(store.loadValid()).toEqual([]); // still consumed — no infinite retries
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("!dead:s"));
    warnSpy.mockRestore();
  });

  it("an empty store sends nothing", async () => {
    const store = seeded([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const sent = await consumeQueueSnapshots(store, { isProjectRoom: () => true, send });
    expect(sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
