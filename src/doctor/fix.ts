/**
 * doctor 修复执行器(spec #337 票 #339,横切机制,#340 复用):
 *  - 只对「安全幂等档」动手:全部幂等、重复执行无二次伤害(各动作自证:
 *    目标状态已达成 → changed=false,不再动文件);
 *  - 涉及配置改写的项:备份先于删除/改写(固定名 <configPath>.doctor-backup,
 *    字节级原样、0600、有界不堆积);备份失败必须放弃该项修复 —— 宁不修,
 *    不可无备份改写(与 config.ts directWriteConfig 的拒绝语义同源);
 *  - 修完逐项打印改前/改后 diff;只有 --fix(或 TTY 确认)会走到这里。
 *
 * 依赖红线与 src/doctor/ 目录一致:node 内置 + i18n 静态;saveConfig 经
 * 动态 import(src/config.js 同源原子写)。
 */

import * as fs from "node:fs";
import { t } from "../i18n/index.js";
import type { Layout } from "../paths.js";
import { toMessage } from "./types.js";

/** 一个修复动作的执行结果。changed=false = 已是目标状态(幂等重跑/竞态),
 *  diff 只在 changed=true 时有意义。notes 为过程备注(如备份路径)。 */
export interface FixOutcome {
  changed: boolean;
  notes?: string[];
  /** 改前 → 改后 diff(可读文本,行首 -/+)。 */
  diff?: string;
}

/** 一项安全幂等修复(对应检查项 id;run 自证幂等)。 */
export interface FixAction {
  checkId: string;
  /** 人话描述(修什么;渲染时与 id 一起打印)。 */
  summary: string;
  run: () => Promise<FixOutcome>;
}

/** 单项执行结果(汇总与退出码重派生用)。 */
export interface FixStepResult {
  checkId: string;
  summary: string;
  changed: boolean;
  diff?: string;
  /** 执行失败原因(失败不拖垮其余动作)。 */
  error?: string;
}

export interface FixRunSummary {
  steps: FixStepResult[];
}

/** 逐项执行修复:输出逐项结果与 diff;单项失败只记录该项,继续其余。
 *  write 是输出通道(薄壳传 io.write)。 */
export async function runFixes(actions: FixAction[], write: (line: string) => void): Promise<FixRunSummary> {
  const steps: FixStepResult[] = [];
  for (const action of actions) {
    try {
      const outcome = await action.run();
      steps.push({
        checkId: action.checkId,
        summary: action.summary,
        changed: outcome.changed,
        ...(outcome.diff !== undefined ? { diff: outcome.diff } : {}),
      });
      if (outcome.changed) {
        write(t("doctor.fix.applied", { id: action.checkId, summary: action.summary }));
        for (const note of outcome.notes ?? []) write(`   ↳ ${note}`);
        if (outcome.diff) {
          for (const line of outcome.diff.split("\n")) write(`   ${line}`);
        }
      } else {
        write(t("doctor.fix.noop", { id: action.checkId, summary: action.summary }));
        for (const note of outcome.notes ?? []) write(`   ↳ ${note}`);
      }
    } catch (err) {
      steps.push({ checkId: action.checkId, summary: action.summary, changed: false, error: toMessage(err) });
      write(t("doctor.fix.failed", { id: action.checkId, message: toMessage(err) }));
    }
  }
  return { steps };
}

/** 修复汇总里「已解决」的检查项 id 集(changed 或幂等无操作都算已解决;
 *  error 项不算)。薄壳用它对剩余 ❌ 重派生退出码。 */
export function resolvedCheckIds(summary: FixRunSummary): Set<string> {
  return new Set(summary.steps.filter((s) => s.error === undefined).map((s) => s.checkId));
}

// ── 配置备份与 diff(配置改写类修复的公共机制)────────────────────────────

/** 配置写入前的固定名备份(<configPath>.doctor-backup;字节级原样,0600,
 *  有界 —— 每次修复覆盖,不堆积)。返回备份路径;原文件不存在或备份失败
 *  返回 undefined —— 调用方必须放弃改写类修复。 */
export function backupConfig(layout: Layout): string | undefined {
  const backupPath = `${layout.configPath}.doctor-backup`;
  try {
    if (!fs.existsSync(layout.configPath)) return undefined;
    fs.copyFileSync(layout.configPath, backupPath);
    fs.chmodSync(backupPath, 0o600);
    return backupPath;
  } catch {
    return undefined;
  }
}

/** 备份失败时抛出的错误文案(修复动作里用它中止该项)。 */
export function backupRequired(layout: Layout): string {
  const backupPath = backupConfig(layout);
  if (!backupPath) {
    throw new Error(t("doctor.fix.backupFailed", { path: layout.configPath }));
  }
  return t("doctor.fix.backup", { path: backupPath });
}

/** 最小行级 diff:改前独有行 -、改后独有行 +。匹配时对行尾逗号/空白做归一
 *  (JSON 删键会让前一行尾逗号消失 —— 逗号摆动不是语义变化,不该进 diff),
 *  输出保留原行文本。配置类修复的两侧都按 saveConfig 的 2 空格规范序列化。 */
export function diffLines(before: string, after: string): string {
  const normalize = (line: string): string => line.trim().replace(/,+$/, "");
  const b = before.split("\n");
  const a = after.split("\n");
  const aNorm = new Set(a.map(normalize));
  const bNorm = new Set(b.map(normalize));
  const lines: string[] = [];
  for (const line of b) if (!aNorm.has(normalize(line))) lines.push(`- ${line}`);
  for (const line of a) if (!bNorm.has(normalize(line))) lines.push(`+ ${line}`);
  return lines.join("\n");
}

// ── TTY 汇总确认的应答解析(纯函数;交互本体在薄壳)───────────────────────

/** [Y/n] 一次确认:空串默认 Y;y/yes/是 → true;n/no/否 → false;其余
 *  (打错字)按安全侧 false —— 宁可不修,不可误解。 */
export function parseConfirmAnswer(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized === "") return true;
  return normalized === "y" || normalized === "yes" || normalized === "是";
}
