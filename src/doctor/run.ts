/**
 * doctor 编排核心(spec #337 票 #338):拼上下文 → 动态加载检查清单 →
 * 逐项执行(守卫降级)→ 产出 DoctorReport。核心保持纯逻辑、可全量注入
 * 测试;渲染与退出码派生在 report.ts,交互 IO 在薄壳层(shell.ts)。
 *
 * 降级机制(spec 工程约束):既有 helper 全部动态 import + try/catch ——
 *  - readBridgeVersion 加载失败 → 报告头版本 "unknown"(只影响报告头);
 *  - loadConfig 加载失败 → ctx.config = undefined(B/C 组相关项自行降级);
 *  - checks 清单模块加载/收集失败 → 整份检查降级 ⏭️(每组一项「无法确认」);
 *  - 单条检查项抛错 → 该项降级 ⏭️(id 保留,guardCheck)。
 * 任何降级都不向上抛;退出码 2 只留给 doctor 自身未捕获崩溃(薄壳 catch)。
 */

import { t } from "../i18n/index.js";
import type {
  CheckGroup,
  CheckResult,
  DoctorCheckEntry,
  DoctorContext,
  DoctorDeps,
  DoctorOptions,
  DoctorReport,
} from "./types.js";
import { toMessage } from "./types.js";

/** 组字母全集(清单模块整体加载失败时的降级占位,按组各出一项)。 */
const ALL_GROUPS: CheckGroup[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** 单条检查项守卫:抛错 = 无法确认,降级 ⏭️(id 保留、原因入文案),
 *  绝不向上抛 —— 一项查不出来不许拖垮整份报告。 */
export async function guardCheck(entry: DoctorCheckEntry): Promise<CheckResult[]> {
  try {
    const out = await entry.run();
    return Array.isArray(out) ? out : [out];
  } catch (err) {
    return [
      {
        id: entry.id,
        group: entry.group,
        severity: "skip",
        summary: t("doctor.degraded", { reason: toMessage(err) }),
      },
    ];
  }
}

/** 既有 helper 的加载兜底:动态 import 抛错返回 undefined,由调用方降级。 */
async function loadHelper<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/** 报告头版本号(readBridgeVersion 同源;helper 加载失败/调用抛错 →
 *  "unknown"。模块解析为 undefined 也按加载失败处理 —— vitest 对抛错
 *  factory 的 mock 会以 undefined 模块 fulfill import(),不能解构)。 */
async function loadBridgeVersion(): Promise<string> {
  try {
    const mod = await loadHelper(() => import("../version.js"));
    return mod?.readBridgeVersion?.() ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** 预载配置快照(loadConfig 同源;失败 → undefined,B/C 组相关项降级)。 */
async function loadConfigSnapshot(): Promise<DoctorContext["config"]> {
  try {
    const mod = await loadHelper(() => import("../config.js"));
    return mod?.loadConfig?.();
  } catch {
    return undefined;
  }
}

/** 清单模块整体不可用(加载/收集抛错)时的降级:每组一项 ⏭️ 占位
 *  (id <组>0),退出码按剩余 ❌ 派生(此处必然无 ❌)。 */
function degradedGroupResults(reason: string): CheckResult[] {
  return ALL_GROUPS.map((group) => ({
    id: `${group}0`,
    group,
    severity: "skip" as const,
    summary: t("doctor.degraded", { reason }),
  }));
}

/**
 * 跑一次 doctor:返回报告(渲染与退出码在薄壳层)。永不抛 —— 检查清单层面
 * 的失败都折成降级项;真正的崩溃(本函数自身 bug)向上抛给薄壳 → 退出码 2。
 */
export async function runDoctor(deps: DoctorDeps, options: DoctorOptions): Promise<DoctorReport> {
  const [version, config] = await Promise.all([loadBridgeVersion(), loadConfigSnapshot()]);
  const ctx: DoctorContext = { deps, options, config };

  const results: CheckResult[] = [];
  try {
    // 清单模块动态 import:加载失败(模块自身损坏/依赖断;vitest 对抛错
    // factory 的 mock 会以 undefined 模块 fulfill import(),同样视作加载
    // 失败)与收集抛错走同一条降级路 —— 整份降级 ⏭️,doctor 继续产出报告。
    const mod = await loadHelper(() => import("./checks.js"));
    if (!mod) throw new Error("checks registry module failed to load");
    const entries = await mod.collectCheckEntries(ctx);
    for (const entry of entries) {
      results.push(...(await guardCheck(entry)));
    }
  } catch (err) {
    results.push(...degradedGroupResults(toMessage(err)));
  }

  return {
    version,
    generatedAt: new Date(deps.now()).toISOString(),
    platform: deps.platform,
    offline: options.offline,
    results,
  };
}
