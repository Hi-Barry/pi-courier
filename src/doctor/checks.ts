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
import { checkGroupB } from "./checks-b.js";
import { checkGroupC } from "./checks-c.js";
import { checkGroupD } from "./checks-d.js";
import { checkGroupE } from "./checks-e.js";
import { checkGroupF } from "./checks-f.js";
import { checkGroupG } from "./checks-g.js";
import { checkGroupH } from "./checks-h.js";
import type { FixAction } from "./fix.js";
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

/**
 * 从检查清单派生本次报告对应的修复动作(#348):门槛(checkId/severity 配对)
 * 声明在每个检查项的 fix.on 上,这里只做机械派生 —— 报告里该 entry.id 的
 * 结果 severity === fix.on 才 make,checkId 统一改写为 entry.id。此前"同一
 * id 三处硬编码"(checks 字符串门槛/工厂字面量/报告结果)的静默失配面消灭:
 * severity 改档必同文件,checkId 以 entry.id 为唯一权威。
 *
 * 提示档(C4 workdir/C6 sessionDir 缺失、D6 旧布局)与不可修复档(C1)的
 * 检查项没有 fix 字段 —— 「不存在的动作」就是提示档/禁区档的硬边界。
 *
 * 平台说明(spec #337 用户故事 24:--fix 的安全项在 Windows 行为一致):动作
 * 不按平台设闸 —— 建目录/清锁/清残留平台无关;唯一 POSIX 专属的 C3 chmod
 * 在 win32 下检查项本身是 ⏭️(checks-c),报告门槛自然放不进来。win32 的
 * 目录权限不可验证 → D1/D2 的「过松收紧」分支不会触发,「缺失建目录」照常
 * 可修(mkdirSync 的 0700 在 win32 由 libuv 映射为可写,与全仓写侧同语义)。
 */
export async function collectFixActions(ctx: DoctorContext, report: { results: CheckResult[] }): Promise<FixAction[]> {
  const actions: FixAction[] = [];
  // 清单重建抛错(模块损坏/依赖断)= 报告已走降级 ⏭️ 占位:与旧字符串门槛
  // 在降级报告上优雅返回空动作同语义,不把修复收集变成退出码 2。
  let entries: DoctorCheckEntry[];
  try {
    entries = await collectCheckEntries(ctx);
  } catch {
    return actions;
  }
  for (const entry of entries) {
    const { fix } = entry;
    if (!fix) continue;
    const result = report.results.find((r) => r.id === entry.id);
    if (!result || result.severity !== fix.on) continue;
    const body = await fix.make(ctx);
    if (body) actions.push({ checkId: entry.id, summary: body.summary, run: body.run });
  }
  return actions;
}
