/**
 * doctor 票 #339 测试:B 组 pi 解析链检查 + 修复执行器 + TTY 汇总确认。
 *
 * 主用例(spec 测试决策的验收锚点,先红后绿):构造残留失效 cliPath(指向
 * 不存在路径)的配置 + pi 实际已安装的布局(fake PATH 注入)→ doctor 报 ❌
 * 且明说「配置里的 pi 路径失效」→ --fix 备份配置、删除该项、打印 diff →
 * 桥回退自动发现重新解析到当前入口 → 再跑 doctor 退出 0。
 *
 * pi 「已安装」的模拟:`which pi` 走真实 PATH(测试把 fake bin 目录前插进
 * PATH),fake 的 bin/pi 是 POSIX shell 包装 → PiRpc.resolveCliPath 的
 * managedInstallEntry 跟随 releases 布局解析到 fake 的 dist/bundle/cli.js
 * —— 与 pi.dev 托管安装同构,不新造解析链。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeLayoutForTests } from "../src/config.js";
import { collectFixActions } from "../src/doctor/checks.js";
import {
  backupConfig,
  diffLines,
  parseConfirmAnswer,
  runFixes,
  type FixAction,
} from "../src/doctor/fix.js";
import { deriveExitCode } from "../src/doctor/report.js";
import { buildDoctorContext, runDoctor } from "../src/doctor/run.js";
import { doctorShell } from "../src/doctor/shell.js";
import type { CheckResult, DoctorDeps } from "../src/doctor/types.js";
import { FIXED_NOW, makeDoctorIO, makeDoctorLayout, makeHarness } from "./doctor-harness.js";

// ── fake pi 安装布局(which pi → 托管 releases 布局)────────────────────────

/** 在 tmp 根搭一套 pi.dev 同构托管安装:bin/pi 包装 + install/releases 树。
 *  agentDir = dirname(dirname(bin/pi)) = tmpRoot。 */
function installFakePi(tmpRoot: string, pkg: { version: string; enginesNode?: string }): string {
  fs.mkdirSync(path.join(tmpRoot, "bin"), { recursive: true });
  const wrapper = path.join(tmpRoot, "bin", "pi");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexec echo fake-pi\n", { mode: 0o755 });
  const pkgDir = path.join(
    tmpRoot,
    "install",
    "releases",
    pkg.version,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  fs.mkdirSync(path.join(pkgDir, "dist", "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "dist", "bundle", "cli.js"), "// fake pi entry\n");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: pkg.version,
      ...(pkg.enginesNode !== undefined ? { engines: { node: pkg.enginesNode } } : {}),
    }),
  );
  fs.writeFileSync(path.join(tmpRoot, "install", "current-version"), `${pkg.version}\n`);
  return path.join(pkgDir, "dist", "bundle", "cli.js");
}

/** 把 fake bin 目录前插进 PATH(返回还原函数)。 */
function withFakePath(binDir: string): () => void {
  const saved = process.env.PATH;
  process.env.PATH = `${binDir}:${saved ?? ""}`;
  return () => {
    process.env.PATH = saved;
  };
}

// ── harness:临时家 + 配置文件 + 环境(PI_* 清场)───────────────────────────

let home: string;
let tmpRoot: string;
let restorePath: () => void;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-doctor-fix-")));
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-fakepi-")));
  savedEnv = { ...process.env };
  // 配置隔离:布局钉进临时家(loadConfig 的 configPath 随之入临时区)。
  const pinnedLayout = makeDoctorLayout("linux", home);
  setRuntimeLayoutForTests(pinnedLayout, home);
  // 健康基线:自管目录预建(0700),让本文件的用例聚焦 B 组与修复执行器,
  // 不被票 #340 的 D1/D2「目录缺失 ⚠️ → 建目录动作」扩散(该组归票 #340 测)。
  fs.mkdirSync(pinnedLayout.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pinnedLayout.dataDir, { recursive: true, mode: 0o700 });
  // PI_CLI_PATH 会被 loadConfig 折进 config.cliPath —— 测试显式清场,
  // 避免开发者/CI 环境污染主用例。
  delete process.env.PI_CLI_PATH;
  delete process.env.PI_MATRIX_HOMESERVER;
  delete process.env.PI_MATRIX_ACCESS_TOKEN;
  restorePath = () => {
    process.env.PATH = savedEnv.PATH;
  };
});

afterEach(() => {
  restorePath();
  process.env = savedEnv;
  setRuntimeLayoutForTests(undefined);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function configPath(): string {
  return makeDoctorLayout("linux", home).configPath;
}

/** 写配置(0600,与 saveConfig 同契约)。 */
function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function readRawConfig(): string {
  return fs.readFileSync(configPath(), "utf-8");
}

async function doctorReport(deps?: DoctorDeps) {
  const d = deps ?? makeHarness({ platform: "linux", homedir: home, env: process.env });
  const ctx = await buildDoctorContext(d, { fix: false, json: false, offline: false });
  const report = await runDoctor(d, { fix: false, json: false, offline: false }, ctx);
  return { ctx, report, deps: d };
}

function resultById(report: { results: CheckResult[] }, id: string): CheckResult | undefined {
  return report.results.find((r) => r.id === id);
}

// ════════════════════════════════════════════════════════════════════════════
// 主用例(验收锚点,先红后绿)
// ════════════════════════════════════════════════════════════════════════════

describe("主用例:失效 cliPath → --fix 备份删除 → 自动发现 → 再跑退出 0", () => {
  it("完整事故回路(spec 用户故事 6/7/8/33)", async () => {
    const fakeEntry = installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    const stalePath = path.join(home, "old-pi", "cli.js"); // 指向不存在路径
    writeConfig({ cliPath: stalePath, workdir: home });

    // ① doctor 报 ❌ 且明说「配置里的 pi 路径失效」,退出码 1
    const first = await doctorReport();
    const b1 = resultById(first.report, "B1");
    expect(b1?.severity).toBe("fail");
    expect(b1?.summary).toContain("配置里的 pi 路径失效");
    expect(b1?.summary).toContain(stalePath);
    expect(b1?.nextStep).toContain("doctor --fix");
    expect(deriveExitCode(first.report.results)).toBe(1);

    // ② collectFixActions 给出 B1 的修复动作;执行:备份先于删除、打印 diff
    const actions = await collectFixActions(first.ctx, first.report);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.checkId).toBe("B1");
    const printed: string[] = [];
    const summary = await runFixes(actions, (line) => printed.push(line));
    expect(summary.steps).toHaveLength(1);
    expect(summary.steps[0]!.changed).toBe(true);
    expect(summary.steps[0]!.error).toBeUndefined();

    // 备份文件存在且含原 cliPath(固定名 <configPath>.doctor-backup;修复动作
    // 在删除前落备份,事后只有备份里还有原样字节)
    const backupPath = `${configPath()}.doctor-backup`;
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupRaw = fs.readFileSync(backupPath, "utf-8");
    expect(backupRaw).toContain(stalePath);
    expect((JSON.parse(backupRaw) as { cliPath?: string }).cliPath).toBe(stalePath);

    // 修完配置不再含 cliPath;权限保持 0600
    const after = JSON.parse(readRawConfig()) as { cliPath?: string };
    expect(after.cliPath).toBeUndefined();
    const mode = fs.statSync(configPath()).mode & 0o777;
    expect(mode.toString(8)).toBe("600");

    // diff 输出显示删除项(改前/改后)
    const diffLines_ = printed.filter((l) => l.trim().startsWith("-") || l.trim().startsWith("+"));
    expect(diffLines_.join("\n")).toContain('"cliPath"');
    expect(printed.join("\n")).toContain("已修复");

    // ③ 桥回退自动发现:再跑 doctor,B1 跳过(未配置)、B2 解析到 fake 当前入口,退出码 0
    const second = await doctorReport();
    const b1After = resultById(second.report, "B1");
    expect(b1After?.severity).toBe("skip"); // 未配置 cliPath,本项不适用
    const b2After = resultById(second.report, "B2");
    expect(b2After?.severity).toBe("ok");
    expect(b2After?.detail).toContain("install/releases/1.0.0");
    expect(b2After?.detail).toContain("dist/bundle/cli.js");
    expect(deriveExitCode(second.report.results)).toBe(0);
    expect(fakeEntry).toContain("dist/bundle/cli.js"); // 解析到的就是 fake 当前入口
  });

  it("修复幂等:同一动作连跑两次无二次伤害;重跑 doctor 不再产生修复动作", async () => {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    writeConfig({ cliPath: path.join(home, "gone", "cli.js") });

    const first = await doctorReport();
    const actions = await collectFixActions(first.ctx, first.report);
    const printed1: string[] = [];
    await runFixes(actions, (l) => printed1.push(l));
    const afterFirst = readRawConfig();

    // 同一动作再跑:cliPath 已不在 → changed=false,配置字节不变
    const printed2: string[] = [];
    const second = await runFixes(actions, (l) => printed2.push(l));
    expect(second.steps[0]!.changed).toBe(false);
    expect(readRawConfig()).toBe(afterFirst);

    // 重跑 doctor:B1 不再 fail → 无修复动作
    const third = await doctorReport();
    expect(resultById(third.report, "B1")?.severity).not.toBe("fail");
    expect(await collectFixActions(third.ctx, third.report)).toEqual([]);
  });
});

/** 主用例 ② 的备注:备份内容 = copyFileSync 的原样字节,直接对固定备份路径断言。 */

// ════════════════════════════════════════════════════════════════════════════
// B 组检查逐项
// ════════════════════════════════════════════════════════════════════════════

describe("B1 — 配置 cliPath 存在性", () => {
  it("指向存在的文件 → ✅", async () => {
    installFakePi(tmpRoot, { version: "1.0.0" });
    writeConfig({ cliPath: path.join(tmpRoot, "install", "releases", "1.0.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js") });
    const { report } = await doctorReport();
    expect(resultById(report, "B1")?.severity).toBe("ok");
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("未配置 cliPath → skip(走自动发现,见 B2)", async () => {
    const { report } = await doctorReport();
    expect(resultById(report, "B1")?.severity).toBe("skip");
  });

  it("win32 注入(POSIX 形布局):B1 照查,路径不存在 → ❌", async () => {
    // 先例 config-win32.test.ts:平台翻转但布局保持 POSIX 形(测试文件系统能落地的形状)
    writeConfig({ cliPath: path.join(home, "missing", "cli.js") });
    const deps = makeHarness({
      platform: "win32",
      homedir: home,
      env: process.env,
    });
    const ctx = await buildDoctorContext(deps, { fix: false, json: false, offline: false });
    const report = await runDoctor(deps, { fix: false, json: false, offline: false }, ctx);
    expect(resultById(report, "B1")?.severity).toBe("fail");
    expect(resultById(report, "B1")?.summary).toContain("配置里的 pi 路径失效");
  });
});

describe("B2 — 自动发现解析链(PiRpc.resolveCliPath 同源)", () => {
  it("无配置 + fake PATH:解析到托管布局入口(dist/bundle/cli.js)", async () => {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    const { report } = await doctorReport();
    const b2 = resultById(report, "B2");
    expect(b2?.severity).toBe("ok");
    expect(b2?.detail).toContain("install/releases/1.0.0");
  });

  it("配置了 cliPath → B2 skip(桥不走自动发现)", async () => {
    installFakePi(tmpRoot, { version: "1.0.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    writeConfig({ cliPath: path.join(tmpRoot, "install", "releases", "1.0.0", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js") });
    const { report } = await doctorReport();
    expect(resultById(report, "B2")?.severity).toBe("skip");
  });
});

describe("B3 — pi 版本对 Node 引擎门(assertPiEngineSupported 语义)", () => {
  it("fake pi 1.0.0 engines>=22.19.0 → ✅(本仓 engines 同源)", async () => {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    const { report } = await doctorReport();
    const b3 = resultById(report, "B3");
    expect(b3?.severity).toBe("ok");
    expect(b3?.detail).toContain("pi@1.0.0");
  });

  it("fake pi engines>=99.0.0 → ❌(引擎门硬要求)", async () => {
    installFakePi(tmpRoot, { version: "1.5.0", enginesNode: ">=99.0.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    const { report } = await doctorReport();
    const b3 = resultById(report, "B3");
    expect(b3?.severity).toBe("fail");
    expect(b3?.summary + " " + (b3?.detail ?? "")).toContain("99");
  });

  it("自定义脚本(非 pi 包)→ 引擎门不适用(ok)", async () => {
    fs.mkdirSync(path.join(tmpRoot, "bin"), { recursive: true });
    const script = path.join(tmpRoot, "custom-cli.js");
    fs.writeFileSync(script, "// not pi\n");
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    writeConfig({ cliPath: script });
    const { report } = await doctorReport();
    const b3 = resultById(report, "B3");
    expect(b3?.severity).toBe("ok");
  });
});

describe("B4 — Node 版本对 pi-courier engines(>=22.19.0)", () => {
  it("当前 CI/开发 Node 满足 → ✅(集成)", async () => {
    const { report } = await doctorReport();
    expect(resultById(report, "B4")?.severity).toBe("ok");
  });

  it("版本比较纯函数:满足/不满足两态", async () => {
    const { nodeSatisfiesEngine } = await import("../src/doctor/checks-b.js");
    expect(nodeSatisfiesEngine([24, 20, 0], [22, 19, 0])).toBe(true);
    expect(nodeSatisfiesEngine([22, 19, 0], [22, 19, 0])).toBe(true);
    expect(nodeSatisfiesEngine([20, 15, 0], [22, 19, 0])).toBe(false);
    expect(nodeSatisfiesEngine([22, 18, 9], [22, 19, 0])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 薄壳:--fix / TTY 汇总确认 / 非 TTY
// ════════════════════════════════════════════════════════════════════════════

describe("doctorShell — 修复交互契约(汇总问一次,不逐项问)", () => {
  function setupStaleConfig(): void {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    writeConfig({ cliPath: path.join(home, "gone", "cli.js") });
  }

  it("--fix:不问直接修,备份落盘,退出码按剩余 ❌ 派生(修好 → 0)", async () => {
    setupStaleConfig();
    const { io, writes, exits } = makeDoctorIO({ isTTY: true });
    const askYesNo = vi.fn(async () => true);
    await doctorShell(["--fix"], makeDoctorLayout("linux", home), { ...io, askYesNo });
    expect(askYesNo).not.toHaveBeenCalled(); // --fix 不问
    expect(fs.existsSync(`${configPath()}.doctor-backup`)).toBe(true);
    expect(writes.join("\n")).toContain("已修复");
    expect(exits).toEqual([0]);
  });

  it("TTY + 确认 Y:修好退出 0;确认 N:不动配置退出 1", async () => {
    setupStaleConfig();
    const yes = makeDoctorIO({ isTTY: true });
    const askYes = vi.fn(async (_question: string) => true);
    await doctorShell([], makeDoctorLayout("linux", home), { ...yes.io, askYesNo: askYes });
    expect(askYes).toHaveBeenCalledTimes(1); // 汇总问一次
    expect(String(askYes.mock.calls[0]?.[0])).toContain("修复以上 1 项安全项");
    expect(fs.existsSync(`${configPath()}.doctor-backup`)).toBe(true);
    expect(yes.exits).toEqual([0]);

    // 重置现场再测 N
    fs.rmSync(`${configPath()}.doctor-backup`, { force: true });
    writeConfig({ cliPath: path.join(home, "gone", "cli.js") });
    const no = makeDoctorIO({ isTTY: true });
    const askNo = vi.fn(async (_question: string) => false);
    await doctorShell([], makeDoctorLayout("linux", home), { ...no.io, askYesNo: askNo });
    expect(JSON.parse(readRawConfig())).toHaveProperty("cliPath"); // 配置未被改
    expect(no.exits).toEqual([1]); // 仍有 ❌
  });

  it("非 TTY 无 --fix:零提问、零写入,退出 1(仍有 ❌)", async () => {
    setupStaleConfig();
    const { io, writes, exits } = makeDoctorIO({ isTTY: false });
    const askYesNo = vi.fn(async (_question: string): Promise<boolean> => {
      throw new Error("non-TTY must never ask");
    });
    await doctorShell([], makeDoctorLayout("linux", home), { ...io, askYesNo });
    expect(askYesNo).not.toHaveBeenCalled();
    expect(JSON.parse(readRawConfig())).toHaveProperty("cliPath"); // 配置未被改
    expect(fs.existsSync(`${configPath()}.doctor-backup`)).toBe(false);
    expect(exits).toEqual([1]);
    expect(writes.join("\n")).toContain("配置里的 pi 路径失效");
  });

  it("--json:纯 JSON 输出,零修复副作用", async () => {
    setupStaleConfig();
    const { io, writes, exits } = makeDoctorIO({ isTTY: true });
    await doctorShell(["--json"], makeDoctorLayout("linux", home), io);
    const parsed = JSON.parse(writes[0]!) as { results: Array<{ id: string; severity: string }> };
    expect(parsed.results.find((r) => r.id === "B1")?.severity).toBe("fail");
    expect(JSON.parse(readRawConfig())).toHaveProperty("cliPath");
    expect(fs.existsSync(`${configPath()}.doctor-backup`)).toBe(false);
    expect(exits).toEqual([1]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 修复执行器单元(备份/diff/确认解析)
// ════════════════════════════════════════════════════════════════════════════

describe("修复执行器单元", () => {
  it("backupConfig:固定名 + 0600 + 字节级一致;无原文件返回 undefined", () => {
    const layout = makeDoctorLayout("linux", home);
    expect(backupConfig(layout)).toBeUndefined(); // 配置不存在 → 无可备份
    writeConfig({ a: 1 });
    const backup = backupConfig(layout)!;
    expect(backup).toBe(`${layout.configPath}.doctor-backup`);
    expect(fs.readFileSync(backup, "utf-8")).toBe(readRawConfig());
    expect((fs.statSync(backup).mode & 0o777).toString(8)).toBe("600");
  });

  it("diffLines:只出增删行,行尾逗号摆动不算变化(改前 - / 改后 +)", () => {
    // 两侧都是 saveConfig 同款 2 空格规范序列化 → 单键删除只出一行
    const diff = diffLines('{\n  "a": 1,\n  "cliPath": "/old"\n}', '{\n  "a": 1\n}');
    expect(diff).toContain('-   "cliPath": "/old"'); // 行首 "- " + 原行缩进
    expect(diff.split("\n")).toHaveLength(1);
  });

  it("parseConfirmAnswer:空串/yes/是 → true;n/否/其他 → false(一次确认,不逐项)", async () => {
    expect(parseConfirmAnswer("")).toBe(true); // [Y/n] 默认 Y
    expect(parseConfirmAnswer("y")).toBe(true);
    expect(parseConfirmAnswer("Y")).toBe(true);
    expect(parseConfirmAnswer("yes")).toBe(true);
    expect(parseConfirmAnswer("是")).toBe(true);
    expect(parseConfirmAnswer("n")).toBe(false);
    expect(parseConfirmAnswer("N")).toBe(false);
    expect(parseConfirmAnswer("no")).toBe(false);
    expect(parseConfirmAnswer("否")).toBe(false);
    expect(parseConfirmAnswer("ys")).toBe(false); // 打错字按安全侧(不修)
  });

  it("runFixes:单项失败不拖垮其余(失败项带 error,成功项照常)", async () => {
    const ok: FixAction = {
      checkId: "D1",
      summary: "ok action",
      run: async () => ({ changed: true, diff: "- x" }),
    };
    const boom: FixAction = {
      checkId: "D2",
      summary: "boom action",
      run: async () => {
        throw new Error("disk on fire");
      },
    };
    const printed: string[] = [];
    const summary = await runFixes([boom, ok], (l) => printed.push(l));
    expect(summary.steps).toHaveLength(2);
    expect(summary.steps[0]!.error).toContain("disk on fire");
    expect(summary.steps[1]!.changed).toBe(true);
    expect(printed.join("\n")).toContain("修复失败");
    expect(printed.join("\n")).toContain("已修复");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 降级:pi-rpc helper 动态 import 抛错 → B 组相关项 ⏭️,doctor 不崩
// ════════════════════════════════════════════════════════════════════════════

describe("降级 — pi-rpc 加载抛错", () => {
  afterEach(() => {
    vi.doUnmock("../src/rpc/pi-rpc.js");
  });

  /** vi.resetModules 后在新模块注册表里重钉布局与语言,再跑一次 doctor。 */
  async function freshDoctor() {
    vi.resetModules();
    vi.doMock("../src/rpc/pi-rpc.js", () => {
      throw new Error("pi-rpc exploded");
    });
    const { runDoctor: freshRunDoctor, buildDoctorContext: freshCtx } = await import("../src/doctor/run.js");
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    // 新注册表的 config.js 实例:布局钉扎已失效,必须重钉(否则读到真实用户
    // 配置)。本块放在文件末尾,防 mock 与新注册表泄漏进其他用例。
    const { setRuntimeLayoutForTests: pinFresh } = await import("../src/config.js");
    pinFresh(makeDoctorLayout("linux", home), home);
    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env });
    const ctx = await freshCtx(deps, { fix: false, json: false, offline: false });
    const report = await freshRunDoctor(deps, { fix: false, json: false, offline: false }, ctx);
    return report;
  }

  it("配置了失效 cliPath:B1(fs-only)照查 ❌、B4 降级 ⏭️,退出码按剩余 ❌ 派生", async () => {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    writeConfig({ cliPath: path.join(home, "gone", "cli.js") });
    const report = await freshDoctor();
    // B1 只用内置 fs:helper 崩了也照查 ❌
    expect(resultById(report, "B1")?.severity).toBe("fail");
    expect(resultById(report, "B1")?.summary).toContain("配置里的 pi 路径失效");
    // B2/B3 在「已配置 cliPath」下是主动跳过(不适用),未触 pi-rpc,文案非降级
    expect(resultById(report, "B2")?.severity).toBe("skip");
    expect(resultById(report, "B2")?.summary).toContain("桥不走自动发现");
    expect(resultById(report, "B3")?.severity).toBe("skip");
    // B4 消费 pi-rpc 的 minNodeVersionOf(同源)→ 降级 ⏭️ 无法确认
    expect(resultById(report, "B4")?.severity).toBe("skip");
    expect(resultById(report, "B4")?.summary).toContain("无法确认");
    // 退出码仍按剩余 ❌ 派生:B1 的 ❌ 不被降级项稀释
    expect(deriveExitCode(report.results)).toBe(1);
  });

  it("未配置 cliPath:B2/B3/B4 全部降级 ⏭️(pi-rpc 不可用),doctor 不崩、退出 0", async () => {
    installFakePi(tmpRoot, { version: "1.0.0", enginesNode: ">=22.19.0" });
    restorePath = withFakePath(path.join(tmpRoot, "bin"));
    // 最小合法配置:C1 不得因「配置缺失」的 ❌ 干扰本用例的退出码断言
    writeConfig({ workdir: home });
    const report = await freshDoctor();
    expect(resultById(report, "B1")?.severity).toBe("skip"); // 未配置 → 不适用
    for (const id of ["B2", "B3", "B4"]) {
      const item = resultById(report, id);
      expect(item?.severity).toBe("skip");
      // vitest 对抛错 factory 的包装文案不稳定(非原样错误消息),只断言降级语义
      expect(item?.summary).toContain("无法确认");
    }
    expect(deriveExitCode(report.results)).toBe(0);
  });
});
