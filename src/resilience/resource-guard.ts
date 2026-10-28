/**
 * L3 资源水位守门(spec #247 票04):磁盘双时机硬退/软告警 + 堆水位。
 * 周期检查挂在票02 的 tick 上(heartbeat.onTick 注入缝,一次 tick 干两件
 * 事,定时器数量不翻倍)。
 *
 * - 启动期硬阈值:startHardThresholdBreached(),组合根在任何网络接线
 *   (Matrix 连接与 pi 拉起之前)调用 —— 低于硬阈值只写死因日志即退、不发
 *   管理房留言,让「满盘 → systemd 拉起 → 启动检查又硬退」的循环每轮不重
 *   连网络、不刷管理房(循环代价由 systemd StartLimitBurst 熔断收敛)。
 * - 运行期硬阈值:runChecks() 低于硬阈值 → 经 onHardExit 缝走「留言 +
 *   非零码优雅退出」链(组合根接共享退出链),死因文本写明磁盘低于硬阈值。
 * - 软阈值:状态翻转去重 —— 正常→告警恰好一条,告警→正常发一条恢复,
 *   反复跨越不刷屏,经注入的 notify 下发(与审计 onDegraded 同款模式)。
 * - 堆水位:heapUsed/上限 ≥ 阈值百分比告警一次(同样翻转去重;恢复静默
 *   翻转,再超限可再告警)。
 *
 * 全部读数走注入缝(磁盘/堆/时钟),测试不碰真实磁盘与内存。
 */

import * as v8 from "node:v8";
import { t } from "../i18n/index.js";

export interface HeapUsage {
  used: number;
  limit: number;
}

export interface ResourceGuardDeps {
  /** 磁盘剩余字节读数缝(组合根注入 diskFreeBytes(workdir);测试注入 fake)。 */
  readDiskFreeBytes: () => number | undefined;
  /** 堆用量读数缝(默认 process.memoryUsage + v8.getHeapStatistics;测试注入)。 */
  readHeap?: () => HeapUsage;
  /** 管理房告警回调(软告警/恢复/堆告警文案已由本模块 i18n 拼好)。
   *  返回 false = 当前无法投递(未配管理房/transport 未连接),守卫不翻转
   *  告警状态、下一 tick 重试 —— 启动期 tick 早于 Matrix 连接,不能把
   *  「还没连上」误当成「已告警」而永久吞掉。undefined/true = 已受理。 */
  notify?: (message: string) => boolean | void;
  /** 运行期硬阈值退出缝(组合根接:管理房死因留言 + 共享退出链非零码)。 */
  onHardExit: (reason: string) => void;
  /** 死因/决策日志。 */
  log: (message: string) => void;
  /** 时钟(保留注入缝,便于未来加时间维度的判断;测试注入 fake)。 */
  now?: () => number;
  /** 阈值(组合根自 config 派生:diskSoftMb/diskHardMb/heapAlertPercent)。 */
  softBytes: number;
  hardBytes: number;
  heapAlertPercent: number;
}

const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

/** 堆用量的默认读数(spec 票04):heapLimit 在 engines 下限 Node 22 的
 *  process.memoryUsage() 上不存在,统一走 v8.getHeapStatistics()(与心跳
 *  同源,全版本可靠)。 */
function readHeapDefault(): HeapUsage {
  return {
    used: process.memoryUsage().heapUsed,
    limit: v8.getHeapStatistics().heap_size_limit,
  };
}

export class ResourceGuard {
  /** 软阈值翻转状态:false=正常态,true=已告警态。 */
  private diskAlerted = false;
  private heapAlerted = false;

  constructor(private readonly deps: ResourceGuardDeps) {}

  /**
   * 启动期硬阈值检查:低于硬阈值返回 true(组合根写完死因日志即退,不发
   * 管理房留言)。磁盘读数不可用时放行(undefined = 判不了,不拦启动)。
   */
  startHardThresholdBreached(): boolean {
    const free = this.deps.readDiskFreeBytes();
    if (free === undefined) return false;
    if (free < this.deps.hardBytes) {
      this.deps.log(
        `[disk] free ${toMb(free)}MB < hard threshold ${toMb(this.deps.hardBytes)}MB — exiting before any network wiring (restart loop cost stays local; systemd StartLimitBurst caps it)`
      );
      return true;
    }
    return false;
  }

  /**
   * 周期检查(heartbeat.onTick):磁盘软告警翻转 → 运行期硬退 → 堆水位。
   * 硬退即 return(进程即将退出,后续检查无意义)。永不抛 —— 调用方
   * (heartbeat tick)另有兜底,但本方法自身保持不抛契约。
   */
  runChecks(): void {
    const free = this.deps.readDiskFreeBytes();
    if (free !== undefined) {
      if (free < this.deps.hardBytes) {
        const message = t("resilience.diskHardExit", {
          free: String(toMb(free)),
          threshold: String(toMb(this.deps.hardBytes)),
        });
        this.deps.log(`[disk] free ${toMb(free)}MB < hard threshold ${toMb(this.deps.hardBytes)}MB — graceful exit`);
        this.deps.onHardExit(message);
        return;
      }
      if (free < this.deps.softBytes && !this.diskAlerted) {
        // 投递成功才翻转:启动期 Matrix 未连接时 notify 返回 false,下一
        // tick(连接完成后)补发,而不是被吞掉后只剩一条无对应告警的恢复。
        if (this.notifyMessage(
          t("resilience.diskSoft", {
            free: String(toMb(free)),
            threshold: String(toMb(this.deps.softBytes)),
            hard: String(toMb(this.deps.hardBytes)),
          })
        )) {
          this.diskAlerted = true;
        }
      } else if (free >= this.deps.softBytes && this.diskAlerted) {
        // 恢复同样要投递成功才清告警态;投不出去下一 tick 再试。
        if (this.notifyMessage(
          t("resilience.diskRecovered", {
            free: String(toMb(free)),
            threshold: String(toMb(this.deps.softBytes)),
          })
        )) {
          this.diskAlerted = false;
        }
      }
    }

    const heap = (this.deps.readHeap ?? readHeapDefault)();
    if (heap.limit > 0) {
      const percent = (heap.used / heap.limit) * 100;
      if (percent >= this.deps.heapAlertPercent && !this.heapAlerted) {
        if (this.notifyMessage(
          t("resilience.heapAlert", {
            percent: String(Math.round(percent)),
            threshold: String(this.deps.heapAlertPercent),
          })
        )) {
          this.heapAlerted = true;
        }
      } else if (percent < this.deps.heapAlertPercent && this.heapAlerted) {
        // 恢复静默翻转(票面文案清单无堆恢复通知):再超限可再告警。
        this.heapAlerted = false;
      }
    }
  }

  /** 投递一条管理房告警:返回 true=已受理(或未接告警通道),false=当前
   *  投不出去、调用方保留翻转状态等下一 tick。notify 同步抛错按投递失败
   *  处理 —— runChecks 的不抛契约不能因告警通道破功。 */
  private notifyMessage(message: string): boolean {
    try {
      return this.deps.notify?.(message) !== false;
    } catch {
      return false;
    }
  }
}
