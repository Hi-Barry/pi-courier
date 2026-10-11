/**
 * AuditLog (issue #124): append-only JSONL evidence. Contract under test:
 * one JSON object per line (ts/event/actor/chatId/detail), 0600 file, never
 * throws into the caller, consecutive-failure counting surfaces ONE degraded
 * notice per threshold window, rotation keeps current + N siblings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../src/logger";
import { AUDIT_EVENTS, AuditLog } from "../src/audit/audit-log";

function tmpFile(name = "audit.jsonl"): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-courier-audit-"));
  return { dir, file: join(dir, name) };
}

describe("AuditLog (issue #124)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("appends one JSON line per event with ts/event/actor/chatId/detail", () => {
    ({ dir } = tmpFile());
    const file = join(dir, "audit.jsonl");
    const audit = new AuditLog(file);
    audit.append("bash.exec", "matrix:@u:s", "!room:s", "! ls -la");
    audit.append(AUDIT_EVENTS.bridgeStart, "system", "");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { ts: number; event: string; actor: string; chatId: string; detail?: string };
    expect(first.event).toBe("bash.exec");
    expect(first.actor).toBe("matrix:@u:s");
    expect(first.chatId).toBe("!room:s");
    expect(first.detail).toBe("! ls -la");
    expect(typeof first.ts).toBe("number");
    // detail 缺省时不得出现 undefined 字面量
    expect(lines[1]).not.toContain("undefined");
  });

  it("creates the file 0600 (evidence is private)", () => {
    ({ dir } = tmpFile());
    const file = join(dir, "audit.jsonl");
    new AuditLog(file).append("reload", "matrix:@u:s", "!room:s");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens a pre-existing loose audit file/dir on first append (audit batch 1 票8)", () => {
    ({ dir } = tmpFile());
    const file = join(dir, "audit.jsonl");
    writeFileSync(file, "old\n", { mode: 0o644 });
    chmodSync(dir, 0o755);

    new AuditLog(file).append("reload", "matrix:@u:s", "!room:s");

    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Old evidence preserved, new line appended.
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines[0]).toBe("old");
    expect(lines).toHaveLength(2);
  });

  it("rotates by size: current → .1 → .2, the oldest falls off", () => {
    ({ dir } = tmpFile());
    const file = join(dir, "audit.jsonl");
    const audit = new AuditLog(file, { rotateBytes: 200, rotateKeep: 2 });
    // 先把 .1 塞满当"上一次的旧档",再写当前文件跨过阈值(恰好一次轮转)
    writeFileSync(`${file}.1`, "x".repeat(150), { mode: 0o600 });
    for (let i = 0; i < 3; i += 1) audit.append("bash.exec", "matrix:@u:s", "!r", `command number ${i} with a reasonably long detail`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    // 旧 .1 的内容被顶到 .2
    expect(readFileSync(`${file}.2`, "utf8")).toBe("x".repeat(150));
    // 当前文件只剩本轮的行
    const current = readFileSync(file, "utf8").trim().split("\n");
    expect(current.length).toBe(1);
    expect(JSON.parse(current[0]!).event).toBe("bash.exec");
  });

  it("counts consecutive failures and fires the degraded notice once per window", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    ({ dir } = tmpFile());
    // 目录位置摆一个同名文件占位 → mkdirSync 目录失败路径不可移植,改用
    // EISDIR 方案(环境无关,与 event-ledger 测试同款):把"文件"做成目录。
    const file = join(dir, "audit.jsonl");
    mkdirSync(file); // append 对目录写必然失败
    const degraded = vi.fn();
    const audit = new AuditLog(file, { warnThreshold: 3, onDegraded: degraded });
    audit.append("reload", "a", "c");
    audit.append("reload", "a", "c");
    expect(degraded).not.toHaveBeenCalled();
    audit.append("reload", "a", "c");
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(degraded.mock.calls[0]![0]).toContain("audit log unavailable");
    // 成功一次清零计数;再失败满阈值重新告警(不刷屏,但也不哑)
    chmodSync(file, 0o500); // r-x 目录,写仍失败
    for (let i = 0; i < 3; i += 1) audit.append("reload", "a", "c");
    expect(degraded).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("survives a throwing onDegraded (notice channel failure is not fatal)", () => {
    ({ dir } = tmpFile());
    const file = join(dir, "audit.jsonl");
    mkdirSync(file);
    const audit = new AuditLog(file, {
      warnThreshold: 1,
      onDegraded: () => {
        throw new Error("management room is gone");
      },
    });
    expect(() => audit.append("reload", "a", "c")).not.toThrow();
  });
});
