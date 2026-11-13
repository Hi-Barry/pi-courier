/**
 * doctor 检查项注册表(spec #337):清单与修复动作的汇聚点。
 *
 * run.ts 经动态 import 加载本模块 —— 模块加载/清单收集失败时整份检查降级
 * ⏭️(每组一项「无法确认」),doctor 不崩。已挂组:
 *  - B 组(票 #339):pi 解析链 + 失效 cliPath 修复;
 * 后续票:#340 C/D 组,#341 A/G/H 组,#342 E/F 组。
 */

import { checkGroupB, staleCliPathFix } from "./checks-b.js";
import type { FixAction } from "./fix.js";
import type { DoctorCheckEntry, DoctorContext, DoctorReport } from "./types.js";

/** 收集本次运行的检查清单。 */
export async function collectCheckEntries(ctx: DoctorContext): Promise<DoctorCheckEntry[]> {
  const entries: DoctorCheckEntry[] = [];
  entries.push(...checkGroupB(ctx));
  return entries;
}

/**
 * 收集本次报告对应的修复动作(只对报告里已报出的可修项;动作内还会自证
 * 幂等重入)。#339:B1 失效 cliPath;#340 追加权限收紧/建目录/清残留。
 */
export async function collectFixActions(ctx: DoctorContext, report: DoctorReport): Promise<FixAction[]> {
  const actions: FixAction[] = [];
  const failing = new Set(report.results.filter((r) => r.severity === "fail").map((r) => r.id));
  if (failing.has("B1")) {
    const fix = await staleCliPathFix(ctx);
    if (fix) actions.push(fix);
  }
  return actions;
}
