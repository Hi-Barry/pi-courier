import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_EVENTS, AuditLog } from "../src/audit/audit-log.js";
import { PendingUpdateStore, consumePendingUpdate } from "../src/update/pending-update.js";

function tmpFile(): { store: PendingUpdateStore; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-update-"));
  const file = path.join(dir, "pending-update.json");
  return { store: new PendingUpdateStore(file), file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const VALID = { from: "1.2.0", to: "1.3.0", startedAt: 1_700_000_000_000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PendingUpdateStore(读侧经 JsonStateFile 吞错,写侧可感知上抛)", () => {
  it("无文件 → read undefined(首启安静)", () => {
    const { store, cleanup } = tmpFile();
    try {
      expect(store.read()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("write → read roundtrip(0600 原子写)", () => {
    const { store, file, cleanup } = tmpFile();
    try {
      store.write(VALID);
      expect(store.read()).toEqual(VALID);
      // 0600 是 POSIX 语义(spec §5.5);Windows 不维护 POSIX 权限位
      // (stat 恒报 0666),只在 POSIX 上断言。
      if (process.platform !== "win32") {
        const mode = fs.statSync(file).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      cleanup();
    }
  });

  it("写失败上抛(可感知契约:不走 JsonStateFile 的吞错 save)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-update-blocker-"));
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "not a dir");
    const store = new PendingUpdateStore(path.join(blocker, "pending-update.json"));
    try {
      expect(() => store.write(VALID)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["from 含换行(注入形态)", { from: "1.3.0\nEVIL", to: "1.3.0", startedAt: 1 }],
    ["缺 to", { from: "1.2.0", startedAt: 1 }],
    ["startedAt 非数字", { from: "1.2.0", to: "1.3.0", startedAt: "soon" }],
    ["from 非字符串", { from: 1, to: "1.3.0", startedAt: 1 }],
  ])("畸形条目(%s)→ 视作无更新并 warn", (_name, entry) => {
    // 直接构造畸形文件(绕过 write,模拟手改或半写)。
    const fresh = tmpFile();
    try {
      fs.writeFileSync(fresh.file, JSON.stringify(entry));
      expect(fresh.store.read()).toBeUndefined();
    } finally {
      fresh.cleanup();
    }
  });

  it("clear 销账:文件消失,read undefined;clear 幂等(无文件不抛)", () => {
    const { store, file, cleanup } = tmpFile();
    try {
      store.write(VALID);
      expect(fs.existsSync(file)).toBe(true);
      store.clear();
      expect(fs.existsSync(file)).toBe(false);
      expect(store.read()).toBeUndefined();
      expect(() => store.clear()).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("consumePendingUpdate(consume-once:queue-snapshots 同款契约)", () => {
  function makeConsumer(overrides: Record<string, unknown> = {}) {
    return {
      send: vi.fn().mockResolvedValue(undefined),
      audit: vi.fn(),
      managementRoomId: "!mgmt:example.org" as string | undefined,
      readVersion: () => "1.3.0",
      ...overrides,
    };
  }

  function seed(entry: unknown): { store: PendingUpdateStore; cleanup: () => void } {
    const fresh = tmpFile();
    fs.writeFileSync(fresh.file, JSON.stringify(entry));
    return { store: fresh.store, cleanup: fresh.cleanup };
  }

  it("合法条目 → 发送回执(v from→to)+ audit update.done(system,chatId=目标)+ 销账", async () => {
    const { store, cleanup } = seed(VALID);
    try {
      const consumer = makeConsumer();
      consumePendingUpdate(store, consumer);
      expect(consumer.send).toHaveBeenCalledWith("!mgmt:example.org", expect.stringContaining("更新完成:v1.2.0 → v1.3.0"));
      expect(consumer.audit).toHaveBeenCalledWith(
        AUDIT_EVENTS.updateDone,
        "system",
        "!mgmt:example.org",
        expect.stringContaining("v1.2.0 → v1.3.0")
      );
      expect(store.read()).toBeUndefined();
      await Promise.resolve(); // send 的 void promise 无未处理拒绝
    } finally {
      cleanup();
    }
  });

  it("发送失败仍销账(consume-once:错过一条通知好过永远重试)", async () => {
    const { store, cleanup } = seed(VALID);
    try {
      const consumer = makeConsumer({ send: vi.fn().mockRejectedValue(new Error("room gone")) });
      consumePendingUpdate(store, consumer);
      expect(consumer.audit).toHaveBeenCalledTimes(1);
      expect(store.read()).toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve)); // send 的 catch 落定
    } finally {
      cleanup();
    }
  });

  it("单工程(managementRoomId undefined)→ 跳过发送、audit 照落(chatId 空串)、销账", async () => {
    const { store, cleanup } = seed(VALID);
    try {
      const consumer = makeConsumer({ managementRoomId: undefined });
      consumePendingUpdate(store, consumer);
      expect(consumer.send).not.toHaveBeenCalled();
      expect(consumer.audit).toHaveBeenCalledWith(AUDIT_EVENTS.updateDone, "system", "", expect.anything());
      expect(store.read()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("磁盘实际版本 ≠ 预期 to → 回执追加不一致警告(actual 过格式校验才可信)", async () => {
    const { store, cleanup } = seed(VALID);
    try {
      const consumer = makeConsumer({ readVersion: () => "1.2.9" });
      consumePendingUpdate(store, consumer);
      const text = consumer.send.mock.calls[0]?.[1] as string;
      expect(text).toContain("更新完成:v1.2.0 → v1.3.0");
      expect(text).toContain("v1.2.9");
      expect(text).toContain("不一致");
      await Promise.resolve();
    } finally {
      cleanup();
    }
  });

  it("无条目 → 零动作(不 send 不 audit 不 clear)", () => {
    const { store, cleanup } = tmpFile();
    try {
      const consumer = makeConsumer();
      consumePendingUpdate(store, consumer);
      expect(consumer.send).not.toHaveBeenCalled();
      expect(consumer.audit).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("畸形条目 → 视作无更新(不 send 不 audit)", () => {
    const { store, cleanup } = seed({ from: "evil\ninjection", to: "1.3.0", startedAt: 1 });
    try {
      const consumer = makeConsumer();
      consumePendingUpdate(store, consumer);
      expect(consumer.send).not.toHaveBeenCalled();
      expect(consumer.audit).not.toHaveBeenCalled();
      expect(store.read()).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("审计落盘:update.done 真写进 AuditLog 的 JSONL(§10 用例 11 完成面)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-update-audit-"));
    try {
      const { store, cleanup } = seed(VALID);
      const audit = new AuditLog(path.join(dir, "audit.jsonl"));
      consumePendingUpdate(store, {
        send: vi.fn().mockResolvedValue(undefined),
        audit: (event, actor, chatId, detail) => audit.append(event, actor, chatId, detail),
        managementRoomId: "!mgmt:example.org",
        readVersion: () => "1.3.0",
      });
      const lines = fs
        .readFileSync(path.join(dir, "audit.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        event: AUDIT_EVENTS.updateDone,
        actor: "system",
        chatId: "!mgmt:example.org",
      });
      expect(String(lines[0]!.detail)).toContain("v1.2.0 → v1.3.0");
      expect(typeof lines[0]!.ts).toBe("number");
      cleanup();
      await Promise.resolve(); // send 的 void promise 落定,无未处理拒绝
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
