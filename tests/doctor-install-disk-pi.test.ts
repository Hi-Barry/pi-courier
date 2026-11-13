/**
 * doctor 票 #341 测试:A 组(安装完整性)、G 组(磁盘对 ResourceGuard 硬阈值
 * 同源)、H 组(pi 侧只读静态,禁区档)。
 *
 * A 组的包根参数化(installChecksForRoot)是纯函数参数化(先例 checks-b 的
 * nodeSatisfiesEngine),不是新测试缝 —— 唯一新测试缝仍是 DoctorDeps;
 * ❌ 分档(缺文件/半更新/peer 缺失/binding 缺失)只有参数化才能在测试里落
 * 临时包根,真实包根只做集成 ✅(CI 是 build → test,dist 恒在)。
 * H 组经 pi 的 PI_CODING_AGENT_DIR env 隔离(getAgentDir 同源),绝不读真实
 * 用户凭据;只读断言:--fix 前后 pi 侧文件逐字节不变。
 */
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeLayoutForTests } from "../src/config.js";
import { installChecksForRoot, versionConsistency } from "../src/doctor/checks-a.js";
import { deriveExitCode } from "../src/doctor/report.js";
import { runDoctor } from "../src/doctor/run.js";
import type { CheckResult, DoctorDeps } from "../src/doctor/types.js";
import { FIXED_NOW, makeDoctorLayout, makeHarness } from "./doctor-harness.js";

// ── harness ─────────────────────────────────────────────────────────────────

let home: string;
let savedEnv: NodeJS.ProcessEnv;
const REAL_ROOT = path.resolve(import.meta.dirname, "..");

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(nodeOs.tmpdir(), "pi-courier-doctor-agh-")));
  savedEnv = { ...process.env };
  const layout = makeDoctorLayout("linux", home);
  setRuntimeLayoutForTests(layout, home);
  // 健康基线(票 #340:C1 配置缺失 ❌、D1/D2 缺失 ⚠️)
  fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(layout.configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.configPath, JSON.stringify({ workdir: home }, null, 2), { mode: 0o600 });
  // H 组隔离:getAgentDir 同源 env 缝 → pi 侧文件全部落临时区
  const agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PI_") && k !== "PI_CODING_AGENT_DIR") delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv;
  setRuntimeLayoutForTests(undefined);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const NO_FIX = { fix: false, json: false, offline: false } as const;

async function doctorReport(depsOverrides: Partial<DoctorDeps> = {}) {
  const deps = makeHarness({ platform: "linux", homedir: home, env: process.env, ...depsOverrides });
  const report = await runDoctor(deps, NO_FIX);
  return { report, deps };
}

function resultById(report: { results: CheckResult[] }, id: string): CheckResult | undefined {
  return report.results.find((r) => r.id === id);
}

// ════════════════════════════════════════════════════════════════════════════
// A 组:安装完整性
// ════════════════════════════════════════════════════════════════════════════

/** 在临时包根搭一套「最小完整安装」的文件树。 */
function installFakePackage(root: string, peer: { version: string } | null, binding: boolean): void {
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "standalone.js"), "// entry\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "pi-courier", version: "1.7.5", main: "dist/standalone.js" }),
  );
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "x.mjs"), "");
  fs.mkdirSync(path.join(root, "deploy"), { recursive: true });
  fs.writeFileSync(path.join(root, "deploy", "pi-courier.service"), "");
  if (peer) {
    for (const [name, version] of [
      ["@earendil-works/pi-ai", "1.0.0"],
      ["@earendil-works/pi-coding-agent", peer.version],
    ] as const) {
      const pkgDir = path.join(root, "node_modules", ...name.split("/"));
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version }));
    }
  }
  if (binding) {
    const cryptoDir = path.join(root, "node_modules", "@matrix-org", "matrix-sdk-crypto-nodejs");
    fs.mkdirSync(cryptoDir, { recursive: true });
    // package.json 必须在:resolveCryptoPackageDirFrom 按 pkg/package.json 解析
    fs.writeFileSync(
      path.join(cryptoDir, "package.json"),
      JSON.stringify({ name: "@matrix-org/matrix-sdk-crypto-nodejs", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(cryptoDir, "matrix-sdk-crypto.linux-x64-gnu.node"), "");
  }
}

describe("A 组 — 关键文件/peer/版本一致/native binding(包根参数化)", () => {
  it("真实包根集成:文件齐全、peer 已装、版本一致、binding 存在 → A1-A4 全 ✅", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, "package.json"), "utf-8")) as { version: string };
    const results = await installChecksForRoot(REAL_ROOT, pkg.version);
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("A1")?.severity).toBe("ok");
    expect(byId.get("A2")?.severity).toBe("ok");
    expect(byId.get("A3")?.severity).toBe("ok");
    expect(byId.get("A4")?.severity).toBe("ok");
  });

  it("缺 dist 入口/关键文件 → ❌ 点名缺失项", async () => {
    installFakePackage(home, { version: "1.0.0" }, true);
    fs.rmSync(path.join(home, "dist", "standalone.js"));
    fs.rmSync(path.join(home, "deploy"), { recursive: true });
    const results = await installChecksForRoot(home, "1.7.5");
    const a1 = results.find((r) => r.id === "A1")!;
    expect(a1.severity).toBe("fail");
    expect(a1.detail).toContain("dist/standalone.js");
    expect(a1.detail).toContain("deploy");
  });

  it("peer 包解析失败 → ❌;pi-coding-agent <0.83 → ❌;>=0.83 → ✅", async () => {
    installFakePackage(path.join(home, "no-peer"), null, true);
    const none = await installChecksForRoot(path.join(home, "no-peer"), "1.7.5");
    expect(none.find((r) => r.id === "A2")?.severity).toBe("fail");

    installFakePackage(path.join(home, "old-peer"), { version: "0.82.0" }, true);
    const old = await installChecksForRoot(path.join(home, "old-peer"), "1.7.5");
    const a2old = old.find((r) => r.id === "A2")!;
    expect(a2old.severity).toBe("fail");
    expect(a2old.summary + " " + (a2old.detail ?? "")).toContain("0.82.0");

    installFakePackage(path.join(home, "ok-peer"), { version: "0.83.0" }, true);
    const ok = await installChecksForRoot(path.join(home, "ok-peer"), "1.7.5");
    expect(ok.find((r) => r.id === "A2")?.severity).toBe("ok");
  });

  it("crypto native binding 缺失 → ❌,存在 → ✅(nativeBindingExists 同源)", async () => {
    installFakePackage(path.join(home, "no-binding"), { version: "1.0.0" }, false);
    const none = await installChecksForRoot(path.join(home, "no-binding"), "1.7.5");
    expect(none.find((r) => r.id === "A4")?.severity).toBe("fail");

    installFakePackage(path.join(home, "with-binding"), { version: "1.0.0" }, true);
    const withIt = await installChecksForRoot(path.join(home, "with-binding"), "1.7.5");
    expect(withIt.find((r) => r.id === "A4")?.severity).toBe("ok"); // ✅ 半边此前漏断言(评审)
  });

  it("版本一致性表驱动:非空且相等 ✅;读不到(半更新)❌;不匹配 ❌", () => {
    expect(versionConsistency("1.7.5", "1.7.5")?.severity).toBe("ok");
    expect(versionConsistency(undefined, "1.7.5")?.severity).toBe("fail");
    expect(versionConsistency("", "1.7.5")?.severity).toBe("fail");
    expect(versionConsistency("1.7.4", "1.7.5")?.severity).toBe("fail");
    expect(versionConsistency("1.7.5", undefined)?.severity).toBe("fail");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// G 组:磁盘对 ResourceGuard 硬阈值(同源 diskHardMb),表驱动
// ════════════════════════════════════════════════════════════════════════════

describe("G 组 — 磁盘水位(注入 diskFreeBytes,阈值同源 diskHardMb/diskSoftMb)", () => {
  const MB = 1024 * 1024;

  async function withDiskConfig(diskHardMb: number, freeMb: number | undefined) {
    // 显式配置硬阈值(resilience.diskHardMb),软阈值随 config.ts 钳制规则派生
    const cfgPath = makeDoctorLayout("linux", home).configPath;
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ workdir: home, resilience: { diskHardMb } }, null, 2),
      { mode: 0o600 },
    );
    return doctorReport({
      diskFreeBytes: () => (freeMb === undefined ? undefined : freeMb * MB),
    });
  }

  it("高于软阈值 → ✅;软硬之间 → ⚠️;低于硬阈值 → ❌ + 退出码 1", async () => {
    // 硬 100MB(显式);软 = max(默认 2048, 101) = 2048MB(config.ts 同源钳制)
    const high = await withDiskConfig(100, 4096);
    expect(resultById(high.report, "G1")?.severity).toBe("ok");

    const near = await withDiskConfig(100, 150); // 150 < 2048(软)且 > 100(硬)
    const g1 = resultById(near.report, "G1");
    expect(g1?.severity).toBe("warn");
    expect(deriveExitCode(near.report.results)).toBe(0);

    const low = await withDiskConfig(100, 90); // 90 < 100(硬)→ 运行时会硬退
    const g1low = resultById(low.report, "G1");
    expect(g1low?.severity).toBe("fail");
    expect(g1low?.summary).toContain("90");
    expect(deriveExitCode(low.report.results)).toBe(1);
  });

  it("读数不可用(undefined)→ ⏭️ 无法确认(不误报)", async () => {
    const { report } = await withDiskConfig(100, undefined);
    const g1 = resultById(report, "G1");
    expect(g1?.severity).toBe("skip");
    expect(g1?.summary).toContain("无法确认");
    expect(deriveExitCode(report.results)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// H 组:pi 侧只读静态(禁区档)
// ════════════════════════════════════════════════════════════════════════════

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR!;
}

function writePiFile(name: string, content: string, mode = 0o600): string {
  fs.mkdirSync(agentDir(), { recursive: true, mode: 0o700 });
  const p = path.join(agentDir(), name);
  fs.writeFileSync(p, content, { mode });
  return p;
}

describe("H 组 — pi 侧只读静态(禁区档,--fix 永不写入)", () => {
  it("agentDir 解析 + auth 有凭据 + settings/models 合法 → H1/H2/H3 ✅,报告脱敏", async () => {
    writePiFile("auth.json", JSON.stringify({ "anthropic:oauth": { token: "syt_dGVzdHRva2VuX3NlY3JldF90b2tlbg" } }));
    writePiFile("settings.json", JSON.stringify({ theme: "dark" }));
    writePiFile("models.json", JSON.stringify({ default: "anthropic/claude-x" }));
    const { report } = await doctorReport();
    expect(resultById(report, "H1")?.severity).toBe("ok");
    expect(resultById(report, "H2")?.severity).toBe("ok");
    expect(resultById(report, "H3")?.severity).toBe("ok");
    const human = JSON.stringify(report);
    expect(human).not.toContain("syt_dGVzdHRva2VuX3NlY3JldF90b2tlbg");
  });

  it("auth.json 损坏 → ❌;settings.json 损坏 → ⚠️(分档)", async () => {
    writePiFile("auth.json", "{ broken");
    const { report } = await doctorReport();
    expect(resultById(report, "H2")?.severity).toBe("fail");
    expect(deriveExitCode(report.results)).toBe(1);

    writePiFile("auth.json", JSON.stringify({ "anthropic:oauth": { token: "x" } }));
    writePiFile("settings.json", "{ broken");
    writePiFile("models.json", "{ broken");
    const second = await doctorReport();
    const h2 = resultById(second.report, "H2");
    expect(h2?.severity).toBe("warn");
    expect(h2?.detail).toContain("settings.json");
    expect(h2?.detail).toContain("models.json");
  });

  it("无凭据且无默认模型 → ⚠️(能跑但有降级,不误报 ❌)", async () => {
    const { report } = await doctorReport();
    // agentDir 空目录:三文件都不存在
    expect(resultById(report, "H3")?.severity).toBe("warn");
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("只读断言:--fix 前后 pi 侧 auth/settings/models 逐字节不变(禁区档)", async () => {
    const authPath = writePiFile("auth.json", JSON.stringify({ "anthropic:oauth": { token: "syt_secretsecretsecret" } }));
    const settingsPath = writePiFile("settings.json", JSON.stringify({ theme: "dark" }));
    const modelsPath = writePiFile("models.json", "{}");
    const before = [authPath, settingsPath, modelsPath].map((p) => fs.readFileSync(p));

    // 同时留一个 C3 可修项(配置权限过松),让 --fix 真有动作可执行
    fs.chmodSync(makeDoctorLayout("linux", home).configPath, 0o644);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env });
    const report = await runDoctor(deps, { fix: true, json: false, offline: false });
    const { collectFixActions } = await import("../src/doctor/checks.js");
    const { buildDoctorContext } = await import("../src/doctor/run.js");
    const ctx = await buildDoctorContext(deps, { fix: true, json: false, offline: false });
    const actions = await collectFixActions(ctx, report);
    expect(actions.some((a) => a.checkId === "C3")).toBe(true); // --fix 真有活干
    const { runFixes } = await import("../src/doctor/fix.js");
    await runFixes(actions, () => {});

    const after = [authPath, settingsPath, modelsPath].map((p) => fs.readFileSync(p));
    expect(after.map((b) => b.toString("utf-8"))).toEqual(before.map((b) => b.toString("utf-8")));
    // 配置权限确实被修了(证明 --fix 真跑了),pi 侧却纹丝不动。
    // mode 只在 POSIX 表达;Windows 宿主跳过该断言,「--fix 真跑了」已由
    // 上方 actions 含 C3 与下方字节断言证明。
    if (process.platform !== "win32") {
      expect(((fs.statSync(makeDoctorLayout("linux", home).configPath).mode ?? 0) & 0o777).toString(8)).toBe(
        "600",
      );
    }
  });

  it("win32 注入:三组照查(PI_CODING_AGENT_DIR 隔离的路径照走),无 ❌", async () => {
    writePiFile("auth.json", JSON.stringify({ "anthropic:oauth": { token: "x" } }));
    const deps = makeHarness({
      platform: "win32",
      homedir: home,
      layout: makeDoctorLayout("linux", home), // POSIX 形布局(config-win32 先例)
      env: process.env,
    });
    const report = await runDoctor(deps, NO_FIX);
    for (const id of ["H1", "H2", "H3", "A1", "A2", "A3", "A4"]) {
      const item = resultById(report, id);
      expect(item?.severity).not.toBe("skip");
      expect(item?.severity).not.toBe("fail");
    }
    expect(deriveExitCode(report.results)).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 降级:helper 加载抛错 → 相关项 ⏭️,退出码按剩余 ❌ 派生
// ════════════════════════════════════════════════════════════════════════════

describe("降级 — A/G/H helper 加载抛错", () => {
  afterEach(() => {
    vi.doUnmock("../src/version.js");
    vi.doUnmock("../src/npm-runtime.js");
    vi.doUnmock("@earendil-works/pi-coding-agent");
  });

  it("version.js 抛错 → A3 ⏭️;npm-runtime 抛错 → A4 ⏭️;pi 包抛错 → H1-H3 ⏭️;G 照查", async () => {
    vi.resetModules();
    vi.doMock("../src/version.js", () => {
      throw new Error("version helper exploded");
    });
    vi.doMock("../src/npm-runtime.js", () => {
      throw new Error("npm-runtime helper exploded");
    });
    vi.doMock("@earendil-works/pi-coding-agent", () => {
      throw new Error("pi package exploded");
    });
    const { runDoctor: freshRunDoctor } = await import("../src/doctor/run.js");
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    const { setRuntimeLayoutForTests: pinFresh } = await import("../src/config.js");
    pinFresh(makeDoctorLayout("linux", home), home);
    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env });
    const report = await freshRunDoctor(deps, NO_FIX);
    // A3/A4/H1-H3 降级 ⏭️(无法确认)
    for (const id of ["A3", "A4", "H1", "H2", "H3"]) {
      const item = resultById(report, id);
      expect(item?.severity, `${id}`).toBe("skip");
      expect(item?.summary).toContain("无法确认");
    }
    // A1/A2(fs+createRequire)照查
    expect(resultById(report, "A1")?.severity).toBe("ok");
    expect(resultById(report, "A2")?.severity).toBe("ok");
    // G 照查(注入读数充足)→ ✅;退出码 0
    expect(resultById(report, "G1")?.severity).toBe("ok");
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("config(helper)抛错 → G1 阈值取不了 → ⏭️,退出码按剩余 ❌ 派生", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => {
      throw new Error("config helper exploded");
    });
    const { runDoctor: freshRunDoctor } = await import("../src/doctor/run.js");
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    // config 抛错 → ctx.config = undefined;G 组阈值取 diskHardMb({}) 会读默认值,
    // 仍能确认 → 断言 G1 用默认阈值语义(✅)而非 ⏭️ —— 与 loadConfig 同源语义一致
    const deps = makeHarness({
      platform: "linux",
      homedir: home,
      env: process.env,
      diskFreeBytes: () => 64 * 1024 * 1024 * 1024,
      now: () => FIXED_NOW,
    });
    const report = await freshRunDoctor(deps, NO_FIX);
    // config 崩掉时 C 组本应降级:runDoctor 的 loadConfigSnapshot 已兜底为
    // undefined,C1 读原始文件(fs-only)照查;G 用默认阈值(diskHardMb({})
    // 的动态 import 也炸 → G1 ⏭️)
    const g1 = resultById(report, "G1");
    expect(g1?.severity).toBe("skip");
    expect(g1?.summary).toContain("无法确认");
    expect(deriveExitCode(report.results)).toBe(0);
  });
});
