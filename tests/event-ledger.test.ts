/**
 * 已处理事件台账(issue #113)单元测试:磁盘是真文件,断言只看外显行为
 * (freshStart 标记、seen/record 往返、坏行容忍、压实窗口)—— 不窥探内部
 * Set 结构。写失败路径用「目录占住文件位」(EISDIR)模拟,不依赖平台特例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_LEDGER_RETENTION_MS, FileEventLedger } from "../src/transports/event-ledger";

describe("FileEventLedger (issue #113)", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-courier-ledger-"));
    file = join(dir, "event-ledger.jsonl");
  });

  afterEach(async () => {
    // record() 的 appendFile 是 fire-and-forget:先给落盘一个窗口再清目录,
    // 否则异步写入会撞上 rmSync(ENOTEMPTY 竞态,审计批3 合并时实测)。
    await new Promise((r) => setTimeout(r, 25));
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = (): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l.trim());

  it("first run: no file → freshStart, init marker written, nothing seen", () => {
    const ledger = new FileEventLedger(file);
    expect(ledger.freshStart).toBe(true);
    expect(ledger.seen("$old")).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0]!).init).toBeTypeOf("number");
  });

  it("restart: records from the previous session are seen, freshStart off", async () => {
    const first = new FileEventLedger(file);
    expect(first.freshStart).toBe(true);
    first.record("$a");
    first.record("$b");
    // 追加是 fire-and-forget:轮询等真正落盘后再「重启」。
    await vi.waitFor(() => {
      expect(readFileSync(file, "utf8")).toContain("$b");
    });

    const second = new FileEventLedger(file);
    expect(second.freshStart).toBe(false);
    expect(second.seen("$a")).toBe(true);
    expect(second.seen("$b")).toBe(true);
    expect(second.seen("$c")).toBe(false);
  });

  it("manually corrupted lines are skipped, good lines survive", () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ init: 1 }),
        "{ this is not json",
        JSON.stringify({ id: "$good", ts: Date.now() }),
        "",
        JSON.stringify({ noid: true }),
        JSON.stringify({ id: "$badts", ts: "yesterday" }),
      ].join("\n") + "\n"
    );
    const ledger = new FileEventLedger(file);
    expect(ledger.freshStart).toBe(false);
    expect(ledger.seen("$good")).toBe(true);
    expect(ledger.seen("$badts")).toBe(false);
  });

  it("compaction: records past the retention window leave disk AND memory", async () => {
    const now = Date.now();
    writeFileSync(
      file,
      [
        JSON.stringify({ init: 1 }),
        JSON.stringify({ id: "$ancient", ts: now - EVENT_LEDGER_RETENTION_MS - 60_000 }),
        JSON.stringify({ id: "$recent", ts: now - 60_000 }),
      ].join("\n") + "\n"
    );
    const ledger = new FileEventLedger(file);
    expect(ledger.seen("$ancient")).toBe(false);
    expect(ledger.seen("$recent")).toBe(true);
    const ids = lines().map((l) => JSON.parse(l).id).filter(Boolean);
    expect(ids).toEqual(["$recent"]);
    // init 标记保留(压实行首)
    expect(JSON.parse(lines()[0]!).init).toBeTypeOf("number");
  });

  it("zero-byte ledger file degrades to first run (audit stability batch 票16)", () => {
    writeFileSync(file, "", "utf8");
    const ledger = new FileEventLedger(file);
    expect(ledger.freshStart).toBe(true); // 宁丢不误:与 unreadable 同语义
    expect(ledger.seen("$x")).toBe(false);
    // 首运 init 落盘,台账恢复有效
    expect(JSON.parse(lines()[0]!).init).toBeTypeOf("number");
  });

  it("entries with non-finite timestamps are dropped, good entries kept (audit stability batch 票16)", () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ id: "$good", ts: Date.now() }),
        // JSON 数字字面量可溢出为 Infinity(1e999);NaN 无法经 JSON 到达,
        // 守卫同样覆盖(防御未来调用方)。
        '{"id":"$inf","ts":1e999}',
        '{"id":"$huge","ts":1e308}',
      ].join("\n") + "\n",
      "utf8",
    );
    const ledger = new FileEventLedger(file);
    expect(ledger.freshStart).toBe(false);
    expect(ledger.seen("$good")).toBe(true);
    expect(ledger.seen("$inf")).toBe(false);
    expect(ledger.seen("$huge")).toBe(true);
  });

  it("unreadable ledger (dir occupying the file path) degrades to first-run, never throws", () => {
    rmSync(file, { force: true });
    mkdirSync(file); // EISDIR on read
    const ledger = new FileEventLedger(file);
    expect(ledger.freshStart).toBe(true);
    expect(ledger.seen("$anything")).toBe(false);
  });

  it("record marks immediately in memory even if disk append has not landed yet", () => {
    const ledger = new FileEventLedger(file);
    ledger.record("$sync");
    expect(ledger.seen("$sync")).toBe(true);
  });
});
