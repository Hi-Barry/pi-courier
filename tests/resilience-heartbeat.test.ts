/**
 * 心跳 tick 基座 + 写侧(spec #247 票02):字段契约、原子写、写失败降级、
 * 配置派生回落、unref 语义。临时目录集成(先例:状态文件测试)+ 注入 fake,
 * 不碰真实磁盘状态目录。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_INTERVAL_SECONDS_DEFAULT, heartbeatIntervalSeconds } from "../src/config";
import { diskFreeBytes } from "../src/resilience/disk-free";
import { Heartbeat } from "../src/resilience/heartbeat";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-heartbeat-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeDeps(overrides: Partial<ConstructorParameters<typeof Heartbeat>[0]> = {}) {
  return {
    filePath: path.join(dir, "heartbeat.json"),
    intervalMs: 30_000,
    readDiskFreeBytes: () => 42 * 1024 * 1024,
    warn: vi.fn(),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe("heartbeat 写侧(spec #247 票02)", () => {
  it("心跳文件含全部六个字段且值来自注入缝", () => {
    const heartbeat = new Heartbeat(fakeDeps());
    heartbeat.writeHeartbeat();

    const sample = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8")) as Record<string, unknown>;
    expect(sample.ts).toBe(1_700_000_000_000);
    expect(sample.pid).toBe(process.pid);
    expect(sample.version).toBeTypeOf("string");
    expect(sample.diskFreeBytes).toBe(42 * 1024 * 1024);
    expect(sample.heapUsed).toBeTypeOf("number");
    expect(sample.heapLimit).toBeTypeOf("number");
    expect(Object.keys(sample).sort()).toEqual(
      ["diskFreeBytes", "heapLimit", "heapUsed", "pid", "ts", "version"].sort()
    );
  });

  it("原子写无残留 tmp,文件 0600、目录 0700(POSIX)", { skip: process.platform === "win32" }, () => {
    const heartbeat = new Heartbeat(fakeDeps());
    heartbeat.writeHeartbeat();

    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["heartbeat.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, "heartbeat.json")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it("写失败不抛、不影响 onTick,下一 tick 正常重试成功", () => {
    // 真实磁盘故障注入(ESM 下无法 spy node:fs):0500 目录创建 tmp 必 EACCES。
    if (process.platform === "win32") return; // POSIX 权限语义,Windows 无意义
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked, { mode: 0o500 });
    const filePath = path.join(locked, "heartbeat.json");
    const onTick = vi.fn();
    const heartbeat = new Heartbeat(fakeDeps({ filePath, onTick }));

    expect(() => heartbeat.runTick()).not.toThrow();
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(filePath)).toBe(false);

    fs.chmodSync(locked, 0o700); // 解锁后下一 tick 重试成功
    expect(() => heartbeat.runTick()).not.toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toHaveProperty("pid");
  });

  it("磁盘读数缝抛错/返回非有限数 → 字段缺省,心跳照常落盘", () => {
    const heartbeat = new Heartbeat(
      fakeDeps({
        readDiskFreeBytes: () => {
          throw new Error("statfs unsupported");
        },
      })
    );
    heartbeat.writeHeartbeat();
    const sample = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8")) as Record<string, unknown>;
    expect(sample).not.toHaveProperty("diskFreeBytes");

    const nan = new Heartbeat(fakeDeps({ readDiskFreeBytes: () => Number.NaN }));
    nan.writeHeartbeat();
    const sample2 = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8")) as Record<string, unknown>;
    expect(sample2).not.toHaveProperty("diskFreeBytes");
  });

  it("onTick 先于心跳写执行(守卫决策优先)", () => {
    const order: string[] = [];
    const heartbeat = new Heartbeat(
      fakeDeps({
        onTick: () => order.push("onTick"),
      })
    );
    const writeSpy = vi.spyOn(heartbeat, "writeHeartbeat").mockImplementation(() => order.push("write"));
    heartbeat.runTick();
    writeSpy.mockRestore();
    expect(order).toEqual(["onTick", "write"]);
  });

  it("onTick 抛错被吞,tick 永不抛、心跳照写", () => {
    const heartbeat = new Heartbeat(
      fakeDeps({
        onTick: () => {
          throw new Error("guard blew up");
        },
      })
    );
    expect(() => heartbeat.runTick()).not.toThrow();
    expect(fs.existsSync(path.join(dir, "heartbeat.json"))).toBe(true);
  });
});

describe("heartbeat 周期与 unref(spec #247 票02)", () => {
  it("start 立即 tick 一次,随后按间隔周期 tick;stop 后不再 tick", () => {
    vi.useFakeTimers();
    try {
      const onTick = vi.fn();
      const heartbeat = new Heartbeat(fakeDeps({ intervalMs: 1_000, onTick }));
      heartbeat.start();
      expect(onTick).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(3_500);
      expect(onTick).toHaveBeenCalledTimes(4);

      heartbeat.stop();
      vi.advanceTimersByTime(10_000);
      expect(onTick).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("定时器 unref —— 优雅退出不被 tick 阻碍的行为锚点", () => {
    vi.useFakeTimers();
    try {
      const unref = vi.fn();
      const intervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
      const heartbeat = new Heartbeat(fakeDeps());
      heartbeat.start();
      expect(unref).toHaveBeenCalledTimes(1);
      intervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("config 派生 heartbeatIntervalSeconds(默认 30,spec #247 票02)", () => {
  it("缺省/非法值回落默认(手编白名单归一)", () => {
    expect(heartbeatIntervalSeconds({})).toBe(HEARTBEAT_INTERVAL_SECONDS_DEFAULT);
    expect(heartbeatIntervalSeconds({ resilience: undefined })).toBe(HEARTBEAT_INTERVAL_SECONDS_DEFAULT);
    expect(heartbeatIntervalSeconds({ resilience: {} })).toBe(HEARTBEAT_INTERVAL_SECONDS_DEFAULT);
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: undefined } })).toBe(
      HEARTBEAT_INTERVAL_SECONDS_DEFAULT
    );
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: 0 } })).toBe(
      HEARTBEAT_INTERVAL_SECONDS_DEFAULT
    );
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: -5 } })).toBe(
      HEARTBEAT_INTERVAL_SECONDS_DEFAULT
    );
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: Number.NaN } })).toBe(
      HEARTBEAT_INTERVAL_SECONDS_DEFAULT
    );
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: Number.POSITIVE_INFINITY } })).toBe(
      HEARTBEAT_INTERVAL_SECONDS_DEFAULT
    );
  });

  it("合法值 floor 到整秒", () => {
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: 60 } })).toBe(60);
    expect(heartbeatIntervalSeconds({ resilience: { heartbeatIntervalSeconds: 10.9 } })).toBe(10);
  });
});

describe("diskFreeBytes(spec #247 票02)", () => {
  it("真实路径返回正数,不存在路径返回 undefined 且不抛", () => {
    const bytes = diskFreeBytes(os.tmpdir());
    expect(bytes).toBeTypeOf("number");
    expect(bytes as number).toBeGreaterThan(0);

    expect(diskFreeBytes(path.join(dir, "definitely-missing-subdir"))).toBeUndefined();
  });
});
