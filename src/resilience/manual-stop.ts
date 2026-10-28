/**
 * 人工停止标记(spec #247 评审):`pi-courier stop` 走 SIGTERM 正常退出
 * (退出码 0),心跳文件仍带最近时间戳;看门狗在一个过期窗口 + 下一轮 cron
 * 后会把「运维刚停掉的服务」判定成 stale/dead 并重新拉起,还会发告警。
 *
 * 语义:
 *  - 正常信号退出(SIGTERM/SIGINT/SIGBREAK)前写标记 → 看门狗看到就跳过;
 *  - 下次桥启动立即清除 → 自动拉起恢复;
 *  - 崩溃守卫与磁盘硬阈值是异常退出路径,刻意不写标记(它们需要被拉起)。
 *
 * 写失败 fire-and-forget(返回 false 由组合根记 warn),不阻断退出 —— 标记
 * 本身不能让优雅退出链失败。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 标记文件名:与心跳同目录,看门狗按文件名派生默认路径。 */
export const MANUAL_STOP_MARKER = "watchdog-paused";

/** 标记文件绝对路径(组合根与看门狗共用同一文件名约定)。 */
export function manualStopMarkerPath(stateDir: string): string {
  return path.join(stateDir, MANUAL_STOP_MARKER);
}

/** 写入人工停止标记(内容为 ISO 时间戳,便于事后排查)。失败返回 false。 */
export function markManualStop(filePath: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 清除人工停止标记(桥启动时调用);不存在/失败都静默。 */
export function clearManualStop(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // 清不掉(权限/只读盘)不阻断启动:看门狗侧下一轮仍会跳过,人工删掉即可
  }
}
