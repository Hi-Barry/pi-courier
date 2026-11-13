/**
 * doctor 薄壳(spec #337 命令面与接线):解析 flags → 拼真实 DoctorDeps →
 * 调核心(runDoctor)→ 渲染报告 → 派生退出码。交互 IO 全在本层,核心保持
 * 纯逻辑、可全量注入测试。
 *
 * - TTY「汇总问一次」确认挂在「报告返回后、修复入口调用前」(CONFIRM 点);
 *   交互行为随票 #339 挂入,非 TTY / --fix / 无可修项时静默跳过。
 * - 非 TTY 永不交互、永不挂起等输入。
 * - 退出码契约:0 = 全健康或仅 ⚠️/⏭️;1 = 仍有 ❌;2 = doctor 自身崩溃
 *   (runDoctor/渲染未捕获异常,catch 统一派生,不走 main().catch 的 1)。
 * - 本层属 src/doctor/,遵守目录静态依赖红线(node 内置 + i18n):既有
 *   helper(disk-free)动态 import + try/catch 降级;layout 由 cli.ts 组合根
 *   注入(模块级已解析,非本目录新增依赖)。
 */

import * as childProcess from "node:child_process";
import * as os from "node:os";
import { t } from "../i18n/index.js";
import { deriveExitCode, renderHuman, renderJson } from "./report.js";
import type { DoctorArgsParse, DoctorDeps, DoctorExecResult, DoctorOptions } from "./types.js";
import { parseDoctorArgs, toMessage } from "./types.js";

/** 薄壳 IO 缝(测试注入;cli.ts 传真实 stdout/stderr/exitCode)。 */
export interface DoctorShellIO {
  /** stdin 是否 TTY(非 TTY 永不交互)。 */
  isTTY: () => boolean;
  /** 报告输出(人话/JSON 都走这里)。 */
  write: (text: string) => void;
  /** 错误与提示(崩溃信息、未知参数)。 */
  error: (text: string) => void;
  /** 退出(默认实现只设 process.exitCode,让事件循环自然收尾;测试捕获)。 */
  exit: (code: number) => void;
}

/** execFile 缝的真实实现(只读查询用;非零退出 resolve 成结果而非 reject)。 */
function execFileResult(file: string, args: string[]): Promise<DoctorExecResult> {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { encoding: "utf-8", timeout: 10_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : -1;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
    });
  });
}

/** 真实 DoctorDeps(薄壳拼装;layout 由 cli.ts 组合根的模块级 LAYOUT 注入;
 *  disk-free 动态 import + try/catch 降级:加载失败返回 undefined → G 组据
 *  undefined 读数自行降级)。 */
export async function realDoctorDeps(layout: DoctorDeps["layout"]): Promise<DoctorDeps> {
  let diskFree: ((forPath: string) => number | undefined) | undefined;
  try {
    diskFree = (await import("../resilience/disk-free.js")).diskFreeBytes;
  } catch {
    diskFree = undefined;
  }
  return {
    platform: process.platform,
    layout,
    homedir: os.homedir(),
    env: process.env,
    execFile: execFileResult,
    fetch: (url, init) => fetch(url, init),
    diskFreeBytes: (forPath) => diskFree?.(forPath),
    now: () => Date.now(),
  };
}

/**
 * doctor 薄壳入口(cli.ts 的 case "doctor" 调用;测试注入 io + layout)。
 * 永不抛:崩溃路径在内部折成退出码 2。
 */
export async function doctorShell(
  argv: string[],
  layout: DoctorDeps["layout"],
  io: DoctorShellIO,
): Promise<void> {
  const parse: DoctorArgsParse = parseDoctorArgs(argv);
  if (!parse.ok) {
    io.error(parse.message);
    io.exit(1);
    return;
  }
  const options: DoctorOptions = parse.options;
  try {
    const deps = await realDoctorDeps(layout);
    const report = await runDoctorWith(options, deps);

    // —— 渲染输出(--json 时 stdout 只印 JSON,jq 可解析)——————
    if (options.json) io.write(`${renderJson(report)}\n`);
    else io.write(`${renderHuman(report)}\n`);

    // —— CONFIRM 点(TTY「汇总问一次」,票 #339 挂交互):报告已出、
    //    修复入口未调。契约:--fix 不问;非 TTY 永不问;无可修项不问。
    //    #338 只留位,此处不产生任何交互。
    io.exit(deriveExitCode(report.results));
  } catch (err) {
    // doctor 自身崩溃(runDoctor/渲染未捕获异常)→ 退出码 2(spec 契约:
    // 2 只留给未捕获崩溃,与「检查发现 ❌」的 1 严格分开)。
    io.error(t("doctor.crashed", { message: toMessage(err) }));
    io.exit(2);
  }
}

/** 便于测试替换核心的内部拐点(生产路径固定 runDoctor)。 */
async function runDoctorWith(options: DoctorOptions, deps: DoctorDeps) {
  const { runDoctor } = await import("./run.js");
  return runDoctor(deps, options);
}
