/**
 * doctor 检查项注册表(spec #337):清单与修复动作的汇聚点。
 *
 * run.ts 经动态 import 加载本模块 —— 模块加载/清单收集失败时整份检查降级
 * ⏭️(每组一项「无法确认」),doctor 不崩。已挂组:
 *  - B 组(票 #339):pi 解析链 + 失效 cliPath 修复;
 *  - C/D 组(票 #340):配置与状态目录 + 权限收紧/建目录/清残留修复;
 *  - A/G/H 组(票 #341):安装完整性、磁盘水位、pi 侧只读(禁区档);
 *  - E/F 组(票 #342):网络(--offline 跳过整组、5 秒超时 ⏭️)与 systemd
 *    服务只读对比(win32 整组 ⏭️)。
 */

import { checkGroupA } from "./checks-a.js";
import { checkGroupE } from "./checks-e.js";
import { checkGroupF } from "./checks-f.js";
import { checkGroupB, staleCliPathFix } from "./checks-b.js";
import { checkGroupC } from "./checks-c.js";
import { checkGroupD } from "./checks-d.js";
import { checkGroupG } from "./checks-g.js";
import { checkGroupH } from "./checks-h.js";
import type { FixAction } from "./fix.js";
import {
  chmodConfigFix,
  clearManualStopFix,
  clearPendingUpdateFix,
  mkdirOrChmodDirFix,
  removeStaleLockFix,
} from "./fixes-cd.js";
import type { CheckResult, DoctorCheckEntry, DoctorContext } from "./types.js";

/** 收集本次运行的检查清单。 */
export async function collectCheckEntries(ctx: DoctorContext): Promise<DoctorCheckEntry[]> {
  const entries: DoctorCheckEntry[] = [];
  entries.push(...checkGroupA(ctx));
  entries.push(...checkGroupB(ctx));
  entries.push(...checkGroupC(ctx));
  entries.push(...checkGroupD(ctx));
  entries.push(...checkGroupE(ctx));
  entries.push(...checkGroupF(ctx));
  entries.push(...checkGroupG(ctx));
  entries.push(...checkGroupH(ctx));
  return entries;
}

/** 报告里对应 id 的结果(修复动作收集的门槛:只修报告报出的问题)。 */
function resultOf(report: { results: CheckResult[] }, id: string): CheckResult | undefined {
  return report.results.find((r) => r.id === id);
}

/**
 * 收集本次报告对应的修复动作(只对报告里已报出的可修项;动作内还会自证
 * 幂等重入)。#339:B1 失效 cliPath。#340:C3 配置权限收紧、D1/D2 建自管
 * 目录/权限收紧、D3 陈旧锁、D4 manual-stop、D5 pending-update。
 * 提示档(C4 workdir/C6 sessionDir 缺失、D6 旧布局)与不可修复档(C1)永远
 * 不出现在这里;禁区档(trustedUsers/session 数据/pi 侧)更不会。
 */
export async function collectFixActions(ctx: DoctorContext, report: { results: CheckResult[] }): Promise<FixAction[]> {
  const actions: FixAction[] = [];
  const failing = new Set(report.results.filter((r) => r.severity === "fail").map((r) => r.id));
  if (failing.has("B1")) {
    const fix = await staleCliPathFix(ctx);
    if (fix) actions.push(fix);
  }
  const posix = ctx.deps.platform !== "win32";
  if (posix) {
    if (resultOf(report, "C3")?.severity === "warn") actions.push(chmodConfigFix(ctx));
    for (const id of ["D1", "D2"] as const) {
      if (resultOf(report, id)?.severity === "warn") actions.push(mkdirOrChmodDirFix(ctx, id));
    }
    if (resultOf(report, "D3")?.severity === "warn") {
      const fix = await removeStaleLockFix(ctx);
      if (fix) actions.push(fix);
    }
    if (resultOf(report, "D4")?.severity === "warn") actions.push(clearManualStopFix(ctx));
    if (resultOf(report, "D5")?.severity === "warn") actions.push(clearPendingUpdateFix(ctx));
  }
  return actions;
}
