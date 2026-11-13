/**
 * doctor 测试 harness(spec #337 票 #338 建立,#339–#342 复用)。
 *
 * 结构参照 tests/update-orchestrator.test.ts 的 deps 注入 makeHarness:临时
 * 目录布局(mkdtemp + realpath) + fake fetch/execFile/diskFreeBytes/now +
 * 真实 fs;布局经 resolveLayout 注入 DoctorDeps,配置读取隔离走 config 模块
 * 的既有测试缝 setRuntimeLayoutForTests(先例 tests/config-win32.test.ts)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import type { DoctorJsonReport } from "../src/doctor/report.js";
import type { DoctorShellIO } from "../src/doctor/shell.js";
import type { DoctorDeps } from "../src/doctor/types.js";
import type { Layout } from "../src/paths.js";
import { resolveLayout } from "../src/paths.js";

/** 平台对路的临时家目录布局(win32 分支带 APPDATA,其余 XDG 缺省)。 */
export function makeDoctorLayout(platform: NodeJS.Platform, home: string): Layout {
  return resolveLayout({
    platform,
    homedir: home,
    env: platform === "win32" ? { APPDATA: path.join(home, "AppData", "Roaming") } : {},
  });
}

/** 固定时钟(默认 2026-11-13T08:00:00Z;golden 与超时测试需要确定时间)。 */
export const FIXED_NOW = Date.parse("2026-11-13T08:00:00.000Z");

/** fake 依赖打底(overrides 覆盖;fetch/execFile 用 vi.fn 便于断言零调用)。
 *  未显式给 layout 时按 overrides 的 platform/homedir 派生,保证布局与家目录
 *  永远一致。 */
export function makeHarness(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const home = overrides.homedir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-doctor-deps-")));
  const platform = overrides.platform ?? "linux";
  return {
    platform,
    layout: overrides.layout ?? makeDoctorLayout(platform, home),
    homedir: home,
    env: {},
    execFile: vi.fn(async (_file: string, _args: string[]) => ({ stdout: "", stderr: "", code: 0 })),
    fetch: vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error("fetch should not be called in this test");
    }),
    diskFreeBytes: () => 64 * 1024 * 1024 * 1024,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

/** 薄壳 IO 缝:stdout/stderr/exit 全收集(测试断言报告与退出码)。 */
export function makeDoctorIO(options: { isTTY?: boolean } = {}): {
  io: DoctorShellIO;
  writes: string[];
  errors: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    io: {
      isTTY: () => options.isTTY ?? false,
      write: (text) => writes.push(text),
      error: (text) => errors.push(text),
      exit: (code) => exits.push(code),
    },
    writes,
    errors,
    exits,
  };
}

/** doctorShell --json 输出解析后的形态。 */
export type DoctorShellResult = DoctorJsonReport;
