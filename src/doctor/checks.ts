/**
 * doctor 检查项注册表(spec #337 票 #338:骨架空集;票 #339–#342 逐组挂入)。
 *
 * run.ts 经动态 import 加载本模块 —— 模块加载/清单收集失败时整份检查降级
 * ⏭️(每组一项「无法确认」),doctor 不崩。本文件随票扩张:
 *  - #339:B 组(pi 解析链)+ 修复执行器的可修项标记;
 *  - #340:C/D 组(配置与状态目录);
 *  - #341:A/G/H 组(安装完整性、磁盘、pi 侧只读);
 *  - #342:E/F 组(网络、systemd 服务)。
 */

import type { DoctorCheckEntry, DoctorContext } from "./types.js";

/** 收集本次运行的检查清单(空检查集 = 骨架可跑,全绿退出 0)。 */
export async function collectCheckEntries(_ctx: DoctorContext): Promise<DoctorCheckEntry[]> {
  return [];
}
