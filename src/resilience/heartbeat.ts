/**
 * 周期自检 tick 基座 + 心跳文件写侧(spec #247 票02)。
 *
 * 桥进程内每 tick(默认 30 秒,config.resilience.heartbeatIntervalSeconds)
 * 做两件事,共用一个定时器是 spec 刻意决策(定时器数量不翻倍):
 *  1. 附加周期检查(onTick 注入缝,票04 的资源水位守卫挂这里,决策优先);
 *  2. 原子写一个心跳 JSON 到派生状态目录(~/.pi/pi-courier-state/):
 *     { ts, pid, version, diskFreeBytes, heapUsed, heapLimit }。
 *
 * 心跳是外部看门狗(票06/07)判定进程死活与僵死的唯一依据。写失败
 * fire-and-forget 降级(与状态文件「磁盘是备份」同语义),永不抛,下一
 * tick 正常重试。tick 定时器 unref —— 不阻碍优雅退出。
 *
 * 看门狗侧的「多久算死」过期秒刻意不进桥的韧性配置段,单点归属看门狗
 * 脚本常量(默认 180 秒 = 6 × 30 秒心跳间隔,文档与脚本注释互指)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { readBridgeVersion } from "../version.js";

/** 心跳文件内容契约(spec #247 L2):看门狗(票06/07)按此读取。 */
export interface HeartbeatSample {
  /** 本次心跳的 Unix 毫秒时间戳(看门狗判僵死的依据)。 */
  ts: number;
  /** 桥进程 PID(看门狗判死亡的依据)。 */
  pid: number;
  /** 桥版本(既有单点读取 readBridgeVersion,不新写第二份 package.json 读取)。 */
  version?: string;
  /** 工作路径所在盘剩余字节(读不到时缺省;事后排查用)。 */
  diskFreeBytes?: number;
  /** V8 堆已用字节(事后排查 + 票04 堆水位的输入)。 */
  heapUsed: number;
  /** V8 堆上限字节(事后排查 + 票04 堆水位的输入)。 */
  heapLimit: number;
}

export interface HeartbeatDeps {
  /** 心跳文件绝对路径(组合根拼:派生状态目录/heartbeat.json)。 */
  filePath: string;
  /** tick 间隔毫秒(组合根自 config 派生 heartbeatIntervalSeconds × 1000)。 */
  intervalMs: number;
  /**
   * 磁盘剩余字节读数缝:组合根注入 diskFreeBytes(workdir);测试注入 fake。
   * 读数抛错按「读不到」处理(字段缺省),不影响心跳落盘。
   */
  readDiskFreeBytes?: () => number | undefined;
  /**
   * 每 tick 的附加周期检查(票04 水位守卫挂载点)。先于心跳写侧执行 ——
   * 守卫决策(可能触发硬退)优先于留下新鲜心跳。抛错被吞,tick 永不抛。
   */
  onTick?: () => void;
  /** 写失败/读数异常的日志(注入;默认 logger.warn)。 */
  warn?: (message: string) => void;
  /** 时间源(测试注入 fake 时钟;默认 Date.now)。 */
  now?: () => number;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: HeartbeatDeps) {
    this.warn = deps.warn ?? ((message) => logger.warn(message));
  }

  /**
   * 启动周期 tick:立即跑一次(桥一起就有心跳可查,看门狗装好后不会把
   * 「刚启动」误判为僵死),随后按间隔周期执行。定时器 unref —— 进程其余
   * 句柄全部退出时它不拦着,优雅退出不被 tick 阻碍。
   */
  start(): void {
    this.runTick();
    this.timer = setInterval(() => this.runTick(), this.deps.intervalMs);
    // unref 在所有受支持平台上都存在;?. 只是防御未来宿主形态。
    this.timer.unref?.();
  }

  /** 停止周期 tick(测试与显式停机用;进程退出主要靠 unref 语义)。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 单次 tick:附加周期检查 → 原子写心跳。任何失败只 warn,永不抛 ——
   * 自检基座本身不许成为新的崩溃源。
   */
  runTick(): void {
    if (this.deps.onTick) {
      try {
        this.deps.onTick();
      } catch (err) {
        this.warn(`heartbeat tick check failed (ignored): ${errorMessage(err)}`);
      }
    }
    this.writeHeartbeat();
  }

  /** 采集并原子写心跳(临时文件 + 改名,与 JsonStateFile.save 同契约:
   *  tmp 带 PID 防两进程互踩、0600 文件、0700 目录)。失败 warn 不抛。 */
  writeHeartbeat(): void {
    const sample: HeartbeatSample = {
      ts: (this.deps.now ?? Date.now)(),
      pid: process.pid,
      version: readBridgeVersion(),
      diskFreeBytes: this.readDiskFree(),
      heapUsed: process.memoryUsage().heapUsed,
      // 堆上限走 v8.getHeapStatistics():process.memoryUsage().heapLimit 仅
      // 新版 Node 提供,engines 下限(≥22.19)上不可靠;heap_size_limit 全
      // 版本等价且恒有值。
      heapLimit: v8.getHeapStatistics().heap_size_limit,
    };
    try {
      fs.mkdirSync(path.dirname(this.deps.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.filePath}.${process.pid}.tmp`;
      try {
        fs.unlinkSync(tmp);
      } catch {
        // absent tmp is the normal case
      }
      fs.writeFileSync(tmp, JSON.stringify(sample, undefined, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.deps.filePath);
      try {
        fs.chmodSync(path.dirname(this.deps.filePath), 0o700);
      } catch {
        // 权限收紧失败不影响本次落盘
      }
    } catch (err) {
      // fire-and-forget 降级:心跳是「磁盘是备份」语义,写不进去不影响主
      // 流程,下一 tick 自然重试;看门狗会看到过期心跳并按设计接管。
      this.warn(
        `heartbeat write failed (watchdog will see a stale beat): ${this.deps.filePath} (${errorMessage(err)})`
      );
    }
  }

  /** 磁盘读数:注入缝抛错/返回非有限数一律按「读不到」处理(字段缺省)。 */
  private readDiskFree(): number | undefined {
    try {
      const value = this.deps.readDiskFreeBytes?.();
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
