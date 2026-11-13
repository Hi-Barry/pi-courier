/**
 * doctor 子命令的类型与纯决策(spec #337 票 #338)。
 *
 * 依赖红线(spec 工程约束):src/doctor/ 下模块的**运行时静态依赖只允许
 * node 内置模块与 src/i18n**;项目内既有 helper(loadConfig、PiRpc.resolveCliPath、
 * nativeBindingExists、resolveProxySettings、lockIsStale、readBridgeVersion、
 * diskFreeBytes 等)一律**动态 import + try/catch**——加载失败只把相关检查项
 * 降级 ⏭️(「无法确认」),绝不向上抛;退出码 2 只留给 doctor 自身未捕获崩溃。
 *
 * 项目内的「类型」(Layout、MsgBridgeConfig)走 type-only import,编译期擦除,
 * 不构成运行时依赖。src/errors.ts 的 errorMessage 同理不静态引入,本地落一份
 * 同义 toMessage —— 5 行纯函数,复制好过破坏依赖红线。
 */

import { t } from "../i18n/index.js";
import type { Layout } from "../paths.js";
import type { MsgBridgeConfig } from "../types.js";

/** doctor 全代码库唯一新增的测试缝(spec「唯一新测试缝:DoctorDeps」):
 *  CLI 薄壳拼真实实现,测试注入 fake;检查一律复用既有 helper 与缝,不新造
 *  解析链。字段集与 spec 冻结清单一致,新增字段先改 spec。 */
export interface DoctorDeps {
  /** 平台判定显式纳入(先例 UpdateOrchestratorDeps):win32 分支在任意 CI
   *  runner 可测(F 组整组 ⏭️、路径跟随 win32 布局分支)。 */
  platform: NodeJS.Platform;
  /** 布局解析结果(spec #258 同源;组合根传 runtimeLayout(),测试传
   *  resolveLayout 的产物)。 */
  layout: Layout;
  /** 用户家目录(os.homedir 的注入缝)。 */
  homedir: string;
  /** 环境变量(PI_CLI_PATH 由 loadConfig 自行消费;此处供其余 env 读取)。 */
  env: Record<string, string | undefined>;
  /** 只读进程查询缝(systemctl cat/is-active/is-enabled 等只读查询)。
   *  契约:实现方保证绝不执行写操作;非零退出 resolve(不 reject)——
   *  「未启用」是正常发现不是错误;无法 spawn 时 code 取负值,stderr 带原因。 */
  execFile: (file: string, args: string[]) => Promise<DoctorExecResult>;
  /** 网络检查缝(全局 fetch 同形;测试注入 fake 三态:立即成功/立即失败/
   *  永不 resolve —— 第三态配合 now/timeout 判 ⏭️)。 */
  fetch: typeof globalThis.fetch;
  /** 磁盘剩余字节(src/resilience/disk-free.ts 同源封装;不可用 → undefined,
   *  G 组相应降级)。 */
  diskFreeBytes: (forPath: string) => number | undefined;
  /** 时钟(报告时间戳与网络超时的注入缝)。 */
  now: () => number;
}

/** execFile 缝的结果三元组(systemctl 未启用返回非零 code,属正常发现)。 */
export interface DoctorExecResult {
  stdout: string;
  stderr: string;
  /** 退出码;非零 = 查询对象不满足条件,负值 = 无法执行(ENOENT 等)。 */
  code: number;
}

// ── 检查项数据结构 ────────────────────────────────────────────────────────────

/** 8 组检查清单的组字母(spec 检查清单表:A 安装完整性 / B pi 解析链 /
 *  C pi-courier 配置 / D 状态与目录 / E 网络 / F 服务 / G 磁盘 / H pi 侧)。 */
export type CheckGroup = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/** 严重度(spec 严重度契约):ok=✅ 健康 / warn=⚠️ 能跑但有风险或降级 /
 *  fail=❌ 桥无法正常启动或核心功能不可用 / skip=⏭️ 无法确认或主动跳过。 */
export type CheckSeverity = "ok" | "warn" | "fail" | "skip";

/** 一条检查结果:稳定 id(组字母 + 序号,如 "B1";多项目等派生项用 "C5.2")
 *  是未来 --only 的锚点;summary/detail/nextStep 都是检查侧已 t() 渲染的人话。 */
export interface CheckResult {
  id: string;
  group: CheckGroup;
  severity: CheckSeverity;
  summary: string;
  detail?: string;
  /** 下一步命令(提示档/修复指引;渲染层统一加前缀)。 */
  nextStep?: string;
}

/** 一条检查项:单项抛错 = 「无法确认」→ 由 runDoctor 降级 ⏭️(id 保留),
 *  检查函数自身只对「能确定答案」的情形返回结果。 */
export interface DoctorCheckEntry {
  id: string;
  group: CheckGroup;
  run: () => Promise<CheckResult | CheckResult[]>;
}

/** 检查上下文:deps + 本次运行的开关 + 预载配置(loadConfig 产物;加载失败
 *  为 undefined,B/C 组相关项据此降级)。 */
export interface DoctorContext {
  deps: DoctorDeps;
  options: DoctorOptions;
  config: MsgBridgeConfig | undefined;
}

/** doctor 报告(渲染纯函数的输入;human/JSON 两形态同源)。 */
export interface DoctorReport {
  /** pi-courier 版本号(readBridgeVersion;helper 加载失败 → "unknown")。
   *  只进报告头。 */
  version: string;
  /** 报告生成时刻(deps.now 派生的 ISO 串)。 */
  generatedAt: string;
  platform: NodeJS.Platform;
  offline: boolean;
  results: CheckResult[];
}

// ── flags 解析(纯决策)────────────────────────────────────────────────────

/** doctor 的三个开关(spec 命令面;v1 不做 --explain/--deep/--only)。 */
export interface DoctorOptions {
  /** 直接修安全幂等档,不问(TTY 汇总确认只针对非 --fix 的交互路径)。 */
  fix: boolean;
  /** 机器可读报告(与 TTY 人话报告同一份脱敏)。 */
  json: boolean;
  /** 跳过全部网络检查(离线机器可跑验收)。 */
  offline: boolean;
}

export const DEFAULT_DOCTOR_OPTIONS: DoctorOptions = { fix: false, json: false, offline: false };

export type DoctorArgsParse =
  | { ok: true; options: DoctorOptions }
  | { ok: false; message: string };

/** 解析 doctor 参数:三个开关可任意组合;位置参数与未知 flag 一律报错
 *  (打错的 flag 静默忽略比报错更危险)。message 已 t() 渲染,直接可打印。 */
export function parseDoctorArgs(args: string[]): DoctorArgsParse {
  const options: DoctorOptions = { ...DEFAULT_DOCTOR_OPTIONS };
  for (const arg of args) {
    if (arg === "--fix") options.fix = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--offline") options.offline = true;
    else {
      return { ok: false, message: t("doctor.unknownArg", { arg }) };
    }
  }
  return { ok: true, options };
}

// ── 本地错误转文案(src/errors.ts 不静态引入,见文件头依赖红线)────────────

/** Safe message extraction(与 src/errors.ts errorMessage 同义):Error →
 *  message,null/undefined → 可读占位,其余 → String()。 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return "(no error value)";
  return String(err);
}
