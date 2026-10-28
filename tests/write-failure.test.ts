/**
 * 写失败聚合(spec #247 票04):ENOSPC/EDQUOT 分类识别、退避窗口内至多
 * 一条告警(首条立即)、非磁盘类错误不进聚合、挂点接线(JsonStateFile /
 * AuditLog / AttachmentStore / FileEventLedger 的注入缝零改契约)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit/audit-log";
import { JsonStateFile } from "../src/state/json-file";
import { AttachmentStore } from "../src/transports/attachments";
import { FileEventLedger } from "../src/transports/event-ledger";
import {
  WRITE_FAILURE_BACKOFF_MAX_MS,
  WRITE_FAILURE_BACKOFF_MS,
  WriteFailureRecorder,
  diskSpaceErrorCode,
  writeFailureBackoffMs,
} from "../src/resilience/write-failure";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-writefail-"));
});

afterEach(() => {
  // 恢复测试里收紧过的目录权限再删(0500 目录 rm 会 EACCES)
  try {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir)) {
      try {
        fs.chmodSync(path.join(dir, entry), 0o700);
      } catch {
        // 非目录或已可写
      }
    }
  } catch {
    // dir 已不在
  }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function enospc(): NodeJS.ErrnoException {
  const err = new Error("no space left on device") as NodeJS.ErrnoException;
  err.code = "ENOSPC";
  return err;
}

function edquot(): NodeJS.ErrnoException {
  const err = new Error("quota exceeded") as NodeJS.ErrnoException;
  err.code = "EDQUOT";
  return err;
}

describe("diskSpaceErrorCode 分类(spec #247 票04)", () => {
  it("ENOSPC/EDQUOT 识别,其余(含 EACCES/ENOENT/无 code)不认", () => {
    expect(diskSpaceErrorCode(enospc())).toBe("ENOSPC");
    expect(diskSpaceErrorCode(edquot())).toBe("EDQUOT");
    const eacc = new Error("denied") as NodeJS.ErrnoException;
    eacc.code = "EACCES";
    expect(diskSpaceErrorCode(eacc)).toBeUndefined();
    expect(diskSpaceErrorCode(new Error("plain"))).toBeUndefined();
    expect(diskSpaceErrorCode("string")).toBeUndefined();
    expect(diskSpaceErrorCode(undefined)).toBeUndefined();
  });
});

describe("WriteFailureRecorder 退避(spec #247 票04)", () => {
  function recorder(overrides = {}) {
    const notify = vi.fn();
    const log = vi.fn();
    let now = 1_000_000;
    const rec = new WriteFailureRecorder({
      notify: (info) => notify(info),
      log,
      now: () => now,
      backoffMs: 5 * 60_000,
      ...overrides,
    });
    const advance = (ms: number) => {
      now += ms;
    };
    return { rec, notify, log, advance };
  }

  it("首条立即,之后按指数退避(5 分钟起步、翻倍),窗口内至多一条(评审)", () => {
    const { rec, notify, advance } = recorder();

    expect(rec.record("state-file", enospc())).toBe(true); // t=0,首条
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ code: "ENOSPC", count: 1, sources: ["state-file"] });

    expect(rec.record("audit", enospc())).toBe(false); // 5 分钟窗口内
    expect(rec.record("attachment", edquot())).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);

    advance(5 * 60_000 + 1); // 第 1 个窗口到期:第二条
    expect(rec.record("event-ledger", enospc())).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith({
      code: "ENOSPC",
      count: 4,
      sources: ["state-file", "audit", "attachment", "event-ledger"],
    });

    advance(5 * 60_000); // 第二条之后窗口翻倍为 10 分钟:还不能发
    expect(rec.record("state-file", enospc())).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);

    advance(5 * 60_000 + 1); // 距第二条已满 10 分钟:第三条
    expect(rec.record("audit", enospc())).toBe(true);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("指数序列与封顶:5 → 10 → 20 → … → 1 小时", () => {
    expect(writeFailureBackoffMs(0)).toBe(WRITE_FAILURE_BACKOFF_MS);
    expect(writeFailureBackoffMs(1)).toBe(WRITE_FAILURE_BACKOFF_MS);
    expect(writeFailureBackoffMs(2)).toBe(2 * WRITE_FAILURE_BACKOFF_MS);
    expect(writeFailureBackoffMs(3)).toBe(4 * WRITE_FAILURE_BACKOFF_MS);
    expect(writeFailureBackoffMs(20)).toBe(WRITE_FAILURE_BACKOFF_MAX_MS);
  });

  it("非磁盘类错误不计数不告警", () => {
    const { rec, notify } = recorder();
    expect(rec.record("state-file", new Error("EACCES-ish"))).toBe(false);
    expect(rec.record("state-file", Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("窗口边界恰好等于 backoffMs 时重新武装", () => {
    const { rec, notify, advance } = recorder();
    rec.record("s", enospc());
    advance(5 * 60_000);
    expect(rec.record("s", enospc())).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe("四个挂点注入缝(既有降级契约零改动,spec #247 票04)", () => {
  it("JsonStateFile.save 磁盘类失败触发缝,永不抛", () => {
    // 真实故障:0500 目录写不进(POSIX)
    if (process.platform === "win32") return;
    const onFail = vi.fn();
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o500 });
    const file = new JsonStateFile<number[]>(path.join(locked, "s.json"), [], onFail);
    expect(() => file.save([1])).not.toThrow();
    expect(onFail).toHaveBeenCalledTimes(1);
    // 缝转发原始错误;磁盘类判定由 recorder 分类(上方已测)
    expect(String(onFail.mock.calls[0][0])).toMatch(/EACCES|EPERM/);
    fs.chmodSync(locked, 0o700);
  });

  it("AttachmentStore 落盘失败触发缝,原错误照抛(回执契约不变)", async () => {
    if (process.platform === "win32") return;
    const onFail = vi.fn();
    const locked = path.join(dir, "blocked");
    fs.mkdirSync(locked, { mode: 0o500 });
    const store = new AttachmentStore(
      { rootDir: locked, maxBytes: 10 * 1024 * 1024 },
      { downloadPlaintext: async () => Buffer.from("hello") },
      onFail
    );
    await expect(
      store.save("!room:server", { mxcUrl: "mxc://x/y", body: "a.png", sizeHint: 5 })
    ).rejects.toThrow(/EACCES|EPERM/);
    expect(onFail).toHaveBeenCalledTimes(1);
    fs.chmodSync(locked, 0o700);
  });

  it("AuditLog 磁盘类失败触发缝且阈值降级契约照旧", () => {
    if (process.platform === "win32") return;
    const onFail = vi.fn();
    const onDegraded = vi.fn();
    const locked = path.join(dir, "alocked");
    fs.mkdirSync(locked, { mode: 0o500 });
    const lockedLog = new AuditLog(path.join(locked, "a.jsonl"), {
      warnThreshold: 2,
      onDegraded,
      onDiskWriteFailure: onFail,
    });
    lockedLog.append("e", "system", "");
    lockedLog.append("e", "system", "");
    expect(onFail).toHaveBeenCalledTimes(2); // 每次失败都过缝
    expect(onDegraded).toHaveBeenCalledTimes(1); // 阈值契约照旧(2 次阈值告警一次)
    fs.chmodSync(locked, 0o700);
  });

  it("FileEventLedger.record 磁盘类失败触发缝(异步)", async () => {
    if (process.platform === "win32") return;
    const onFail = vi.fn();
    const locked = path.join(dir, "llocked");
    fs.mkdirSync(locked, { mode: 0o700 });
    // 构造本身要写 init 行 —— 用可写目录构造;锁目录前删掉文件(0500 目录
    // 只挡「新文件创建」,已存在文件照常可追加)
    const ledger = new FileEventLedger(path.join(locked, "ledger.jsonl"), { onDiskWriteFailure: onFail });
    fs.rmSync(path.join(locked, "ledger.jsonl"), { force: true });
    fs.chmodSync(locked, 0o500);
    ledger.record("evt-1");
    await vi.waitFor(() => expect(onFail).toHaveBeenCalled());
    fs.chmodSync(locked, 0o700);
  });
});
