/**
 * 磁盘剩余空间读数(spec #247 票02):心跳字段与票04 水位守卫共用的唯一
 * statfs 封装。Node 内建 fs.statfs,Windows 由 libuv 映射到等价系统调用
 * (部署机 Node ≥ 22.19 均具备)。读不到(平台差异/权限/路径不存在)返回
 * undefined,由调用方决定降级语义 —— 本函数自身永不抛。
 */

import * as fs from "node:fs";

/** forPath 所在盘的剩余字节;bavail × bsize(free blocks available to
 *  unprivileged users × file system block size)。 */
export function diskFreeBytes(forPath: string): number | undefined {
  try {
    const stats = fs.statfsSync(forPath);
    return stats.bsize * stats.bavail;
  } catch {
    return undefined;
  }
}
