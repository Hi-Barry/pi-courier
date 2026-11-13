/**
 * doctor 报告渲染纯函数(spec #337 票 #338):CheckResult → TTY 人话报告
 * (按组、报告头带 pi-courier 版本号)与 --json 机器可读报告;退出码派生。
 *
 * 全部纯函数:不碰 fs/网络/时钟,输入决定输出,golden 断言稳定。人话与 JSON
 * 两形态共用同一份脱敏(maskSecrets)—— token/key 最多露前 4 位,超打不欠打。
 */

import { type MessageKey, t } from "../i18n/index.js";
import type { CheckGroup, CheckResult, CheckSeverity, DoctorReport } from "./types.js";

/** 严重度 → 状态符号(spec 严重度契约;符号跨语言固定,文案走 i18n)。 */
export const SEVERITY_SYMBOL: Record<CheckSeverity, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  skip: "⏭️",
};

/** 组字母 → i18n 键(动态拼 key 过不了 MessageKey 联合类型,冻结映射表)。 */
const GROUP_KEY: Record<CheckGroup, MessageKey> = {
  A: "doctor.group.A",
  B: "doctor.group.B",
  C: "doctor.group.C",
  D: "doctor.group.D",
  E: "doctor.group.E",
  F: "doctor.group.F",
  G: "doctor.group.G",
  H: "doctor.group.H",
};

// ── 脱敏(spec 输出契约:token/key 最多露前 4 位)─────────────────────────────

/** URL 查询参数里的凭据值(?token=…&access_token=…&key=… 等)。 */
const SECRET_QUERY_PARAM = /([?&](?:access_token|access-token|refresh_token|token|key|password|secret)=)[^&\s"']+/gi;
/** URL userinfo 里的密码(scheme://user:pass@host → 保留 user,打掉 pass)。 */
const URL_PASSWORD = /(:\/\/[^/\s:@]+:)([^/\s@]+)(@)/g;
/** Matrix 现代 token(syt_ 前缀):前 4 字符恰好是 "syt_",整段保留前缀打其余。 */
const MATRIX_TOKEN = /\bsyt_[A-Za-z0-9_-]+\b/g;
/** 通用兜底:≥24 字符、含数字的连续 base64url 形串(老式 Synapse token、
 *  不透明凭据串)。含数字要求避免误伤包名/长英文词(误伤可接受、漏打不可)。 */
const OPAQUE_SECRET = /\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g;

/** 打码一段文本:疑似凭据只留前 4 位,其余以 **** 代替。规则按序:
 *  查询参数 → URL 密码 → syt_ token → 通用不透明串。人话与 JSON 两形态共用,
 * 宁可错打不可漏打。 */
export function maskSecrets(text: string): string {
  return text
    .replace(SECRET_QUERY_PARAM, (_m, prefix: string) => `${prefix}****`)
    .replace(URL_PASSWORD, (_m, head: string, _pass, tail: string) => `${head}****${tail}`)
    .replace(MATRIX_TOKEN, (m) => `${m.slice(0, 4)}****`)
    .replace(OPAQUE_SECRET, (m) => `${m.slice(0, 4)}****`);
}

// ── 汇总与排序 ────────────────────────────────────────────────────────────────

export type SeverityCounts = Record<CheckSeverity, number>;

/** 按严重度计数(退出码派生与报告尾汇总共用)。 */
export function countSeverities(results: CheckResult[]): SeverityCounts {
  const counts: SeverityCounts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.severity] += 1;
  return counts;
}

/** id 内的比较段:按数字段数值比较("B10" 排在 "B2" 后;字母段按字典序)。 */
function naturalCompare(a: string, b: string): number {
  const aParts = a.split(/(\d+)/);
  const bParts = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const av = aParts[i] ?? "";
    const bv = bParts[i] ?? "";
    const aNum = /^\d+$/.test(av) ? Number(av) : undefined;
    const bNum = /^\d+$/.test(bv) ? Number(bv) : undefined;
    if (aNum !== undefined && bNum !== undefined) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

/** 报告用排序:组字母 A→H,组内按 id 自然序;稳定(同输入同输出)。 */
export function sortResults(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => {
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    return naturalCompare(a.id, b.id);
  });
}

/** 按组聚合(组字母升序;组内自然序)。渲染与 JSON 共用。 */
export function groupResults(results: CheckResult[]): Array<[CheckGroup, CheckResult[]]> {
  const sorted = sortResults(results);
  const out: Array<[CheckGroup, CheckResult[]]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last[0] === r.group) last[1].push(r);
    else out.push([r.group, [r]]);
  }
  return out;
}

// ── 退出码派生(spec 严重度与退出码契约)────────────────────────────────────

/** 全 ✅ / 仅 ⚠️(含 ⏭️)→ 0;含 ❌ → 1。只有 ❌ 让退出码变 1 是有意为之
 *  (⚠️ 表示「能跑但有风险」,CI 不该挡合并);2 = doctor 自身崩溃,由薄壳
 *  的 catch 派生,不经本函数。 */
export function deriveExitCode(results: CheckResult[]): 0 | 1 {
  return results.some((r) => r.severity === "fail") ? 1 : 0;
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

/** TTY 人话报告:报告头(版本号 + 日期 + 平台)→ 按组列出(符号 + id +
 *  说明 + 细节/下一步)→ 尾部汇总行。空检查集打印占位说明。generatedAt
 *  只在 JSON 形态保留完整时间戳,人话报告头只显示日期部分。 */
export function renderHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    t("doctor.reportHeader", {
      version: report.version,
      date: report.generatedAt.slice(0, 10),
      platform: report.platform,
    }),
  );
  if (report.offline) lines.push(t("doctor.offlineNote"));
  if (report.results.length === 0) {
    lines.push(t("doctor.noChecks"));
  }
  for (const [group, items] of groupResults(report.results)) {
    lines.push("");
    lines.push(t(GROUP_KEY[group]));
    for (const item of items) {
      lines.push(`  ${SEVERITY_SYMBOL[item.severity]} ${item.id} ${maskSecrets(item.summary)}`);
      if (item.detail) lines.push(`     ↳ ${maskSecrets(item.detail)}`);
      if (item.nextStep) lines.push(`     ↳ ${t("doctor.nextStep", { cmd: maskSecrets(item.nextStep) })}`);
    }
  }
  const counts = countSeverities(report.results);
  lines.push("");
  lines.push(
    t("doctor.summary", {
      ok: counts.ok,
      warn: counts.warn,
      fail: counts.fail,
      skip: counts.skip,
    }),
  );
  return lines.join("\n");
}

/** --json 机器可读报告的内存形态(jq 可断言;results 与 summary 同源)。 */
export interface DoctorJsonReport {
  version: string;
  generatedAt: string;
  platform: string;
  offline: boolean;
  results: Array<{
    id: string;
    group: string;
    severity: CheckSeverity;
    summary: string;
    detail?: string;
    nextStep?: string;
  }>;
  summary: SeverityCounts;
}

/** 纯函数:DoctorReport → 脱敏后的 JSON 形态(渲染与测试断言共用)。 */
export function buildJsonReport(report: DoctorReport): DoctorJsonReport {
  return {
    version: report.version,
    generatedAt: report.generatedAt,
    platform: report.platform,
    offline: report.offline,
    results: sortResults(report.results).map((r) => ({
      id: r.id,
      group: r.group,
      severity: r.severity,
      summary: maskSecrets(r.summary),
      ...(r.detail !== undefined ? { detail: maskSecrets(r.detail) } : {}),
      ...(r.nextStep !== undefined ? { nextStep: maskSecrets(r.nextStep) } : {}),
    })),
    summary: countSeverities(report.results),
  };
}

/** --json 输出形态(缩进两格,stdout 只印这一段;jq 可解析)。 */
export function renderJson(report: DoctorReport): string {
  return JSON.stringify(buildJsonReport(report), null, 2);
}
