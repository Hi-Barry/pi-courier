/**
 * 桥内写路径的磁盘故障聚合(spec #247 票04):统一按 err.code 识别
 * ENOSPC/EDQUOT,聚合计数后低频告警 —— 首条立即,之后退避窗口(默认 5
 * 分钟)内至多一条,让「写不进去」可见且不刷屏。
 *
 * 挂点(组合根把 record 包装注入各写路径的失败分支):状态文件保存、审计
 * 日志追加、附件落盘、离线事件台账追加。**聚合边界**:事故实录里 8 分钟
 * 14 条 ENOSPC WARN 的实际来源是 pi 子进程侧扩展经 stderr 透传,不在桥内
 * 写路径、本机制管不到 —— 「不再刷屏」由软阈值一条告警 + 硬阈值快速退出
 * 达成(票04 验收口径)。本机制消除的是桥内四挂点各自的逐条可见性缺失;
 * 各写路径既有降级契约(状态文件永不抛、审计阈值告警、台账磁盘为备份)
 * 一律不变 —— record 是附加层,不是替换。
 */

/** 磁盘空间类错误的 code 归一:ENOSPC(空间尽)/EDQUOT(配额超);
 *  非磁盘类错误返回 undefined(由各写路径原有降级契约处理)。 */
export function diskSpaceErrorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? code : undefined;
}

/** 退避窗口默认(毫秒):首条立即,之后窗口内至多一条(spec 票04 口径
 *  「5 分钟至多一条」;固定窗口,不随次数放大 —— 刷屏防治要的是上限,
 *  不是更慢的提醒)。 */
export const WRITE_FAILURE_BACKOFF_MS = 5 * 60_000;

export interface DiskWriteFailureInfo {
  /** 触发本次告警的错误 code(ENOSPC/EDQUOT)。 */
  code: string;
  /** 自进程启动以来的累计聚合条数(跨窗口累计,展示规模感)。 */
  count: number;
  /** 出现过磁盘类写失败的挂点名(去重)。 */
  sources: string[];
}

export interface WriteFailureRecorderDeps {
  /**
   * 告警回调(组合根拼 i18n 文案路由管理房;未配管理房自行静默)。
   * fire-and-forget:实现抛错由调用方组装处兜,不进写路径。
   */
  notify?: (info: DiskWriteFailureInfo) => void;
  /** 聚合计数的英文日志(磁盘类写失败永远至少在日志可见)。 */
  log: (message: string) => void;
  /** 时钟(测试注入 fake)。 */
  now?: () => number;
  /** 退避窗口毫秒(测试缩短;默认 WRITE_FAILURE_BACKOFF_MS)。 */
  backoffMs?: number;
}

export class WriteFailureRecorder {
  private total = 0;
  private lastNotifiedAt = Number.NEGATIVE_INFINITY;
  private readonly sources = new Set<string>();

  constructor(private readonly deps: WriteFailureRecorderDeps) {}

  /**
   * 写路径失败分支调用:磁盘类错误聚合计数,退避窗口内至多一条告警
   * (首条立即);非磁盘类错误忽略(返回 false,走原降级契约)。
   * 返回本次是否发出了告警。
   */
  record(source: string, err: unknown): boolean {
    const code = diskSpaceErrorCode(err);
    if (!code) return false;
    this.total += 1;
    this.sources.add(source);
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastNotifiedAt >= (this.deps.backoffMs ?? WRITE_FAILURE_BACKOFF_MS)) {
      this.lastNotifiedAt = now;
      const sources = [...this.sources];
      this.deps.log(`[disk] write failure ${code} aggregated: ${this.total} hit(s) at [${sources.join(", ")}]`);
      this.deps.notify?.({ code, count: this.total, sources });
      return true;
    }
    return false;
  }
}
