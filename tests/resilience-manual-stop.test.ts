/**
 * 人工停止标记(spec #247 评审):正常信号退出前写、启动时清;失败不抛。
 * 用临时目录,不碰真实状态目录。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANUAL_STOP_MARKER,
  beginManualStopIntent,
  clearManualStop,
  manualStopMarkerPath,
  markManualStop,
} from "../src/resilience/manual-stop";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-manual-stop-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("人工停止标记(spec #247 评审)", () => {
  it("路径与看门狗约定一致:状态目录/watchdog-paused", () => {
    expect(manualStopMarkerPath(dir)).toBe(path.join(dir, MANUAL_STOP_MARKER));
    expect(MANUAL_STOP_MARKER).toBe("watchdog-paused");
  });

  it("写入/清除幂等;内容带 ISO 时间戳便于排查", () => {
    const marker = manualStopMarkerPath(dir);
    expect(fs.existsSync(marker)).toBe(false);

    expect(markManualStop(marker)).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, "utf-8")).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    clearManualStop(marker);
    expect(fs.existsSync(marker)).toBe(false);
    expect(() => clearManualStop(marker)).not.toThrow(); // 不存在也静默
  });

  it("目录不可写时写失败返回 false、不抛", () => {
    if (process.platform === "win32") return;
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o500 });
    expect(markManualStop(path.join(locked, MANUAL_STOP_MARKER))).toBe(false);
    fs.chmodSync(locked, 0o700);
  });

  it("beginManualStopIntent:成功保留、未确认停止回滚(第3轮评审)", () => {
    const intent = beginManualStopIntent(dir);
    expect(intent.written).toBe(true);
    expect(intent.markerPath).toBe(manualStopMarkerPath(dir));
    expect(fs.existsSync(intent.markerPath)).toBe(true);

    intent.settle(true); // 已确认停止:标记保留
    expect(fs.existsSync(intent.markerPath)).toBe(true);

    intent.settle(false); // 未确认停止:回滚,看门狗不失明
    expect(fs.existsSync(intent.markerPath)).toBe(false);
  });

  it("beginManualStopIntent:写失败时 written=false,回滚也不抛", () => {
    if (process.platform === "win32") return;
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o500 });
    const intent = beginManualStopIntent(locked);
    expect(intent.written).toBe(false);
    expect(() => intent.settle(false)).not.toThrow();
    fs.chmodSync(locked, 0o700);
  });
});
