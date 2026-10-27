/**
 * AttachmentLedger module 直测(2026-10-27 扫描批次 A 的兑现):账本状态机
 * 不再借 router 全家桶,在自家 interface 上验 —— park/peek/release 两段式
 * 消费纪律、房间销账、24h TTL 装载、磁盘形状。端到端注入链路另见
 * router-attachments.test.ts(经 router 全管道)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentLedgerKey, AttachmentLedger } from "../src/rpc/attachment-ledger";
import type { PersistedAttachmentEntry } from "../src/rpc/attachment-ledger";
import { JsonStateFile } from "../src/state/json-file";
import type { MessageAttachment } from "../src/types";

const ATT_A: MessageAttachment = { path: "/tmp/a.png", filename: "a.png", bytes: 1 };
const ATT_B: MessageAttachment = { path: "/tmp/b.png", filename: "b.png", bytes: 2 };

describe("AttachmentLedger(扫描批次 A,module 直测,spec #225)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-courier-attledger-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function diskLedger(): AttachmentLedger {
    return new AttachmentLedger(new JsonStateFile<PersistedAttachmentEntry[]>(join(tmpDir, "attachments.json"), []));
  }

  function onDisk(): PersistedAttachmentEntry[] {
    return JSON.parse(readFileSync(join(tmpDir, "attachments.json"), "utf8")) as PersistedAttachmentEntry[];
  }

  it("park 追加同发送者清单,首停时间不顺延;peek 非破坏性读取", () => {
    const ledger = diskLedger();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    ledger.park("!r:s", "@a:s", [ATT_A]);
    vi.setSystemTime(2000);
    ledger.park("!r:s", "@a:s", [ATT_B]);
    vi.useRealTimers();
    // 首停时间只记第一次(落盘 TTL 依据)
    const entries = onDisk();
    expect(entries).toHaveLength(1);
    expect(entries[0].at).toBe(1000);
    expect(entries[0].attachments).toEqual([ATT_A, ATT_B]);
    // peek 不动账:连续两次结果一致
    expect(ledger.peek("!r:s", "@a:s")).toEqual([ATT_A, ATT_B]);
    expect(ledger.peek("!r:s", "@a:s")).toEqual([ATT_A, ATT_B]);
  });

  it("两段式消费:release 才清账 —— 失败不消耗的纪律落在接口形状上", () => {
    const ledger = diskLedger();
    ledger.park("!r:s", "@a:s", [ATT_A]);
    // peek(prompt 失败,不 release)→ 附件仍在
    expect(ledger.peek("!r:s", "@a:s")).toEqual([ATT_A]);
    // release(prompt 成功)→ 清空
    ledger.release("!r:s", "@a:s");
    expect(ledger.peek("!r:s", "@a:s")).toBeUndefined();
    expect(onDisk()).toEqual([]);
    // release 空条目为幂等 no-op
    ledger.release("!r:s", "@a:s");
    expect(onDisk()).toEqual([]);
  });

  it("purgeRoom 只清该房间条目,其余房间保留", () => {
    const ledger = diskLedger();
    ledger.park("!r1:s", "@a:s", [ATT_A]);
    ledger.park("!r1:s", "@b:s", [ATT_B]);
    ledger.park("!r2:s", "@a:s", [ATT_A]);
    expect(ledger.purgeRoom("!r1:s")).toBe(2);
    expect(ledger.peek("!r1:s", "@a:s")).toBeUndefined();
    expect(ledger.peek("!r1:s", "@b:s")).toBeUndefined();
    expect(ledger.peek("!r2:s", "@a:s")).toEqual([ATT_A]);
    expect(ledger.purgeRoom("!r1:s")).toBe(0);
  });

  it("装载:TTL 内条目恢复,过期/残缺/空清单条目静默跳过", () => {
    const file = join(tmpDir, "attachments.json");
    const fresh: PersistedAttachmentEntry = { chatId: "!r:s", userId: "@a:s", at: Date.now(), attachments: [ATT_A] };
    const stale: PersistedAttachmentEntry = {
      chatId: "!r:s",
      userId: "@old:s",
      at: Date.now() - 25 * 60 * 60 * 1000,
      attachments: [ATT_B],
    };
    const broken = { chatId: 42, userId: "@x:s", at: Date.now(), attachments: [ATT_A] } as unknown as PersistedAttachmentEntry;
    const emptyList: PersistedAttachmentEntry = { chatId: "!r:s", userId: "@e:s", at: Date.now(), attachments: [] };
    writeFileSync(file, JSON.stringify([fresh, stale, broken, emptyList]));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ledger = new AttachmentLedger(new JsonStateFile<PersistedAttachmentEntry[]>(file, []));
    expect(ledger.peek("!r:s", "@a:s")).toEqual([ATT_A]);
    expect(ledger.peek("!r:s", "@old:s")).toBeUndefined();
    expect(ledger.peek("!r:s", "@e:s")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("不注入 JsonStateFile = 纯内存形态:park/peek/release 正常", () => {
    const ledger = new AttachmentLedger();
    ledger.park("!r:s", "@a:s", [ATT_A]);
    expect(ledger.peek("!r:s", "@a:s")).toEqual([ATT_A]);
    ledger.release("!r:s", "@a:s");
    expect(ledger.peek("!r:s", "@a:s")).toBeUndefined();
  });

  it("attachmentLedgerKey:房间与发送者双分量区分,分隔符无歧义", () => {
    expect(attachmentLedgerKey("!r:s", "@a:s")).toContain("\u0000");
    expect(attachmentLedgerKey("!r:s", "@a:s")).not.toBe(attachmentLedgerKey("!r:s", "@b:s"));
    expect(attachmentLedgerKey("!r:s", "@a:s")).not.toBe(attachmentLedgerKey("!r2:s", "@a:s"));
  });
});
