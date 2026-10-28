/**
 * L3 资源水位守门(spec #247 票04):软告警/恢复翻转去重、启动期与运行期
 * 硬阈值、堆水位翻转。全部注入 fake 磁盘/堆/时钟,不碰真实磁盘。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DISK_HARD_MB_DEFAULT,
  DISK_SOFT_MB_DEFAULT,
  HEAP_ALERT_PERCENT_DEFAULT,
  diskHardMb,
  diskSoftMb,
  heapAlertPercent,
} from "../src/config";
import { ResourceGuard, type ResourceGuardDeps } from "../src/resilience/resource-guard";

const MB = 1024 * 1024;

function makeDeps(overrides: Partial<ResourceGuardDeps> = {}) {
  const deps: ResourceGuardDeps = {
    readDiskFreeBytes: vi.fn(() => 10 * 1024 * MB),
    notify: vi.fn(),
    onHardExit: vi.fn(),
    log: vi.fn(),
    now: vi.fn(() => 1_000_000),
    softBytes: 2048 * MB,
    hardBytes: 512 * MB,
    heapAlertPercent: 80,
    readHeap: vi.fn(() => ({ used: 10, limit: 100 })),
    ...overrides,
  };
  return { deps, notify: deps.notify as ReturnType<typeof vi.fn>, onHardExit: deps.onHardExit as ReturnType<typeof vi.fn> };
}

describe("磁盘软阈值翻转去重(spec #247 票04)", () => {
  it("跌破软阈值恰好告警一条,反复跨越不发第二条", () => {
    let free = 3 * 1024 * MB;
    const { deps, notify } = makeDeps({ readDiskFreeBytes: () => free });
    const guard = new ResourceGuard(deps);

    guard.runChecks(); // 3GB:正常
    expect(notify).not.toHaveBeenCalled();

    free = 1 * 1024 * MB; // 跌破 2GB 软阈值
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(1);

    free = 1.5 * 1024 * MB; // 仍在软阈值下:不重复
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(1);

    free = 2.5 * 1024 * MB; // 回升 → 恢复一条
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(2);

    free = 1 * 1024 * MB; // 再跌破 → 再告警(新翻转)
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("2048"));
  });

  it("回升发恢复一条(恢复文案可辨识)", () => {
    let free = 1 * 1024 * MB;
    const { deps, notify } = makeDeps({ readDiskFreeBytes: () => free });
    const guard = new ResourceGuard(deps);
    guard.runChecks();
    free = 3 * 1024 * MB;
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(String(notify.mock.calls[1][0])).toContain("✅");
  });

  it("磁盘读数不可用(undefined)不告警不硬退", () => {
    const { deps, notify, onHardExit } = makeDeps({ readDiskFreeBytes: () => undefined });
    const guard = new ResourceGuard(deps);
    expect(guard.startHardThresholdBreached()).toBe(false);
    guard.runChecks();
    expect(notify).not.toHaveBeenCalled();
    expect(onHardExit).not.toHaveBeenCalled();
  });

  it("启动期未连接(notify 返回 false)→ 不翻转,连接后补发恰好一条(评审)", () => {
    let free = 1 * 1024 * MB; // 已在软阈值下
    let connected = false;
    const notify = vi.fn(() => connected);
    const { deps } = makeDeps({ readDiskFreeBytes: () => free, notify });
    const guard = new ResourceGuard(deps);

    guard.runChecks(); // 启动期 tick:Matrix 尚未连接
    expect(notify).toHaveBeenCalledTimes(1);
    guard.runChecks(); // 仍未连接:继续尝试,但不允许「已告警」状态提前置位
    expect(notify).toHaveBeenCalledTimes(2);

    connected = true;
    guard.runChecks(); // 连上后补发
    expect(notify).toHaveBeenCalledTimes(3);
    guard.runChecks(); // 已告警态:不再重复
    expect(notify).toHaveBeenCalledTimes(3);

    free = 3 * 1024 * MB; // 回升:恰好一条恢复
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it("恢复投递失败保留告警态,投递恢复后补发恢复(评审)", () => {
    let free = 1 * 1024 * MB;
    let connected = true;
    const notify = vi.fn(() => connected);
    const { deps } = makeDeps({ readDiskFreeBytes: () => free, notify });
    const guard = new ResourceGuard(deps);

    guard.runChecks(); // 软告警一条
    expect(notify).toHaveBeenCalledTimes(1);

    free = 3 * 1024 * MB;
    connected = false;
    guard.runChecks(); // 恢复投不出去:状态保持「已告警」
    expect(notify).toHaveBeenCalledTimes(2);

    connected = true;
    guard.runChecks(); // 补发恢复
    expect(notify).toHaveBeenCalledTimes(3);
    guard.runChecks(); // 已恢复态:不再重复
    expect(notify).toHaveBeenCalledTimes(3);
  });
});

describe("启动期硬阈值(spec #247 票04)", () => {
  it("低于硬阈值返回 true(组合根据此即退),管理房通知回调零调用", () => {
    const { deps, notify } = makeDeps({ readDiskFreeBytes: () => 400 * MB });
    const guard = new ResourceGuard(deps);

    expect(guard.startHardThresholdBreached()).toBe(true);
    // 启动期不发管理房留言:重启循环每轮不重连网络、不刷管理房
    expect(notify).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("hard threshold"));
  });

  it("高于硬阈值返回 false,正常启动", () => {
    const { deps } = makeDeps({ readDiskFreeBytes: () => 600 * MB });
    expect(new ResourceGuard(deps).startHardThresholdBreached()).toBe(false);
  });
});

describe("运行期硬阈值(spec #247 票04)", () => {
  it("低于硬阈值触发 onHardExit,死因文本写明磁盘低于硬阈值,且后续检查不执行", () => {
    let free = 100 * MB;
    let heapCalls = 0;
    const { deps, notify, onHardExit } = makeDeps({
      readDiskFreeBytes: () => free,
      readHeap: vi.fn(() => {
        heapCalls += 1;
        return { used: 10, limit: 100 };
      }),
    });
    const guard = new ResourceGuard(deps);

    guard.runChecks();

    expect(onHardExit).toHaveBeenCalledTimes(1);
    expect(String(onHardExit.mock.calls[0][0])).toContain("512"); // 硬阈值 MB 数入文案
    expect(String(onHardExit.mock.calls[0][0])).toContain("🚨");
    // 硬退即 return:软告警与堆检查都不再执行
    expect(notify).not.toHaveBeenCalled();
    expect(heapCalls).toBe(0);
    free = 3 * 1024 * MB;
    guard.runChecks(); // 硬退后不再翻回(进程即将退出)
    expect(onHardExit).toHaveBeenCalledTimes(1);
  });
});

describe("堆水位翻转去重(spec #247 票04)", () => {
  it("超限告警恰好一次,回升静默翻转,再超限可再告警", () => {
    let heap = { used: 90, limit: 100 }; // 90% ≥ 80%
    const { deps, notify } = makeDeps({ readHeap: () => heap });
    const guard = new ResourceGuard(deps);

    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain("80");

    guard.runChecks(); // 仍超限:不重复
    expect(notify).toHaveBeenCalledTimes(1);

    heap = { used: 50, limit: 100 }; // 回升:静默翻转
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(1);

    heap = { used: 95, limit: 100 }; // 再超限:再告警
    guard.runChecks();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("limit 为 0(读不出)不告警", () => {
    const { deps, notify } = makeDeps({ readHeap: () => ({ used: 1, limit: 0 }) });
    new ResourceGuard(deps).runChecks();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("韧性配置派生:磁盘/堆阈值(spec #247 票04)", () => {
  it("缺省/非法值回落默认", () => {
    expect(diskHardMb({})).toBe(DISK_HARD_MB_DEFAULT);
    expect(diskHardMb({ resilience: { diskHardMb: 0 } })).toBe(DISK_HARD_MB_DEFAULT);
    expect(diskHardMb({ resilience: { diskHardMb: Number.NaN } })).toBe(DISK_HARD_MB_DEFAULT);
    expect(diskSoftMb({})).toBe(DISK_SOFT_MB_DEFAULT);
    expect(diskSoftMb({ resilience: { diskSoftMb: -1 } })).toBe(DISK_SOFT_MB_DEFAULT);
    expect(heapAlertPercent({})).toBe(HEAP_ALERT_PERCENT_DEFAULT);
    expect(heapAlertPercent({ resilience: { heapAlertPercent: 0 } })).toBe(HEAP_ALERT_PERCENT_DEFAULT);
  });

  it("合法值生效", () => {
    expect(diskHardMb({ resilience: { diskHardMb: 256 } })).toBe(256);
    expect(diskSoftMb({ resilience: { diskSoftMb: 4096 } })).toBe(4096);
    expect(heapAlertPercent({ resilience: { heapAlertPercent: 90.9 } })).toBe(90);
  });

  it("不变式 软 > 硬:手编倒挂时软阈值钳为硬阈值 +1(合理性锚定)", () => {
    expect(diskSoftMb({ resilience: { diskSoftMb: 256, diskHardMb: 512 } })).toBe(513);
    expect(diskSoftMb({ resilience: { diskSoftMb: 512, diskHardMb: 512 } })).toBe(513);
  });

  it("堆百分比钳制到 [1,100]", () => {
    expect(heapAlertPercent({ resilience: { heapAlertPercent: 500 } })).toBe(100);
  });
});
