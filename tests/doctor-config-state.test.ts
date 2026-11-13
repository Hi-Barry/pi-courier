/**
 * doctor 票 #340 测试:C 组(pi-courier 配置)与 D 组(状态与目录)检查,
 * 及复用票 #339 修复执行器的剩余安全修复(权限收紧、建自管目录、清残留)。
 *
 * 三档边界均有断言:
 *  - 安全幂等档(--fix 自动做):chmod 0600/0700(备份先于改)、创建缺失
 *    自管目录、清陈旧锁/manual-stop/pending-update 残留 —— 全部幂等;
 *  - 提示档(只报告 + 下一步):workdir 缺失绝不代建、旧布局残留只给迁移指引;
 *  - 禁区档(--fix 永不碰):trustedUsers、session/数据原样不变。
 */
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeLayoutForTests } from "../src/config.js";
import { collectFixActions } from "../src/doctor/checks.js";
import { runFixes, resolvedCheckIds } from "../src/doctor/fix.js";
import { deriveExitCode } from "../src/doctor/report.js";
import { runDoctor } from "../src/doctor/run.js";
import { doctorShell } from "../src/doctor/shell.js";
import type { CheckResult, DoctorDeps, DoctorOptions } from "../src/doctor/types.js";
import { makeDoctorIO, makeDoctorLayout, makeHarness } from "./doctor-harness.js";

// ── harness ─────────────────────────────────────────────────────────────────

let home: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(nodeOs.tmpdir(), "pi-courier-doctor-cd-")));
  savedEnv = { ...process.env };
  setRuntimeLayoutForTests(makeDoctorLayout("linux", home), home);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PI_")) delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv;
  setRuntimeLayoutForTests(undefined);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const NO_FIX: DoctorOptions = { fix: false, json: false, offline: false };

function layout() {
  return makeDoctorLayout("linux", home);
}

function configPath(): string {
  return layout().configPath;
}

function stateDir(): string {
  return layout().stateDir;
}

function writeConfig(config: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode });
}

function writeRawConfig(raw: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), raw, { mode });
}

function fileMode(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

async function doctorReport(config?: Record<string, unknown>, depsOverrides: Partial<DoctorDeps> = {}) {
  if (config !== undefined) writeConfig(config);
  const deps = makeHarness({ platform: "linux", homedir: home, env: process.env, ...depsOverrides });
  const report = await runDoctor(deps, NO_FIX);
  return { report, deps };
}

function resultById(report: { results: CheckResult[] }, id: string): CheckResult | undefined {
  return report.results.find((r) => r.id === id);
}

/** 对当前报告执行 --fix 修复路径(收集动作 → 执行 → 返回输出与已解决 id)。 */
async function fixCurrent(
  deps: DoctorDeps,
  report: { results: CheckResult[] },
): Promise<{ printed: string[]; resolved: Set<string> }> {
  // collectFixActions 需要 ctx(config 快照);重建一份同源上下文
  const { buildDoctorContext } = await import("../src/doctor/run.js");
  const ctx = await buildDoctorContext(deps, NO_FIX);
  const actions = await collectFixActions(ctx, report);
  const printed: string[] = [];
  const summary = await runFixes(actions, (l) => printed.push(l));
  return { printed, resolved: resolvedCheckIds(summary) };
}

// ════════════════════════════════════════════════════════════════════════════
// C 组:pi-courier 配置
// ════════════════════════════════════════════════════════════════════════════

describe("C1 — 配置文件存在/可读/JSON 合法", () => {
  it("配置缺失 → ❌ + 提示先跑 setup,--fix 不修(不可修复档)", async () => {
    const { report, deps } = await doctorReport(undefined);
    const c1 = resultById(report, "C1");
    expect(c1?.severity).toBe("fail");
    expect(c1?.summary).toContain("配置文件缺失");
    expect(c1?.nextStep).toContain("setup");
    expect(deriveExitCode(report.results)).toBe(1);
    // C1 是不可修复档:任何修复动作都不对应 C1(D1/D2 的建目录动作不受影响)
    const actions = await collectFixActionsNoCtx(deps, report);
    expect(actions.filter((a) => a.checkId === "C1")).toHaveLength(0);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it("合法 JSON → ✅;坏 JSON → ❌(不掩盖 loadConfig 的降级读取)", async () => {
    const ok = await doctorReport({ workdir: home });
    expect(resultById(ok.report, "C1")?.severity).toBe("ok");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeRawConfig("{ not json !");
    const bad = await doctorReport();
    const c1 = resultById(bad.report, "C1");
    expect(c1?.severity).toBe("fail");
    expect(c1?.summary).toContain("不是合法 JSON");
    expect(c1?.nextStep).toBeTruthy();
    expect(deriveExitCode(bad.report.results)).toBe(1);
  });
});

/** collectFixActions 便捷封装(临时家目录布局已 pin,ctx 由 harness 重建)。 */
async function collectFixActionsNoCtx(deps: DoctorDeps, report: { results: CheckResult[] }) {
  const { buildDoctorContext } = await import("../src/doctor/run.js");
  const ctx = await buildDoctorContext(deps, NO_FIX);
  return collectFixActions(ctx, report);
}

describe("C2 — 关键字段类型", () => {
  it("homeserverUrl/trustedUsers 类型坏 → ❌ 点名字段", async () => {
    const { report } = await doctorReport({
      matrix: { homeserverUrl: 123, accessToken: "tok" },
      auth: { trustedUsers: "not-an-array" },
    });
    const c2 = resultById(report, "C2");
    expect(c2?.severity).toBe("fail");
    expect(c2?.summary + " " + (c2?.detail ?? "")).toContain("homeserverUrl");
    expect(c2?.summary + " " + (c2?.detail ?? "")).toContain("trustedUsers");
    expect(deriveExitCode(report.results)).toBe(1);
  });

  it("字段全好/缺省 → ✅", async () => {
    const { report } = await doctorReport({
      matrix: { homeserverUrl: "https://hs.example", accessToken: "tok" },
      auth: { trustedUsers: ["@a:hs"] },
      workdir: home,
      multiProject: false,
    });
    expect(resultById(report, "C2")?.severity).toBe("ok");
    expect(deriveExitCode(report.results)).toBe(0);
  });
});

describe("C3 — 配置 0600 权限(POSIX)与 win32 ⏭️", () => {
  it("0600 → ✅;0644 → ⚠️,--fix 收紧(备份先于改、mode diff、0600 落地)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {}); // 压掉 loadConfig 自检告警
    const good = await doctorReport({ workdir: home });
    expect(resultById(good.report, "C3")?.severity).toBe("ok");

    fs.chmodSync(configPath(), 0o644);
    const loose = await doctorReport({ workdir: home });
    const c3 = resultById(loose.report, "C3");
    expect(c3?.severity).toBe("warn");
    expect(c3?.summary).toContain("权限过松");
    // ⚠️ 不抬退出码(spec:只有 ❌ 让退出码变 1)
    expect(deriveExitCode(loose.report.results.filter((r) => r.id !== "C4"))).toBe(0);

    const { printed, resolved } = await fixCurrent(loose.deps, loose.report);
    expect(resolved.has("C3")).toBe(true);
    expect(fileMode(configPath())).toBe("600");
    // 备份契约:改前先备份(文件字节原样),修完打印 mode diff
    const backup = `${configPath()}.doctor-backup`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.readFileSync(backup, "utf-8")).toContain("workdir");
    expect(printed.join("\n")).toContain("已修复");
    expect(printed.join("\n")).toMatch(/644/);
    // 幂等:再跑一遍无动作
    const again = await doctorReport({ workdir: home });
    expect(resultById(again.report, "C3")?.severity).toBe("ok");
  });

  it("win32 注入:权限检查 ⏭️(libuv 报不出 POSIX mode),--fix 不给动作", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig({ workdir: home }, 0o644);
    const deps = makeHarness({ platform: "win32", homedir: home, env: process.env });
    // 布局保持 POSIX 形(config-win32 先例:平台翻转、布局不跟)
    const report = await runDoctor(deps, NO_FIX);
    const c3 = resultById(report, "C3");
    expect(c3?.severity).toBe("skip");
    expect(c3?.summary).toContain("无法确认");
    expect(await collectFixActionsNoCtx(deps, report).then((a) => a.length)).toBe(0);
    expect(fileMode(configPath())).toBe("644"); // 未被改
  });
});

describe("C4 — workdir 存在且可写(含多项目)", () => {
  it("配置的 workdir 缺失 → ❌ + 下一步 mkdir;--fix 绝不代建(提示档)", async () => {
    const missing = path.join(home, "no-such-workdir");
    const { report, deps } = await doctorReport({ workdir: missing });
    const c4 = resultById(report, "C4");
    expect(c4?.severity).toBe("fail");
    expect(c4?.summary).toContain("目录缺失");
    expect(c4?.nextStep).toContain("mkdir");
    expect(fs.existsSync(missing)).toBe(false);
    const { resolved } = await fixCurrent(deps, report);
    expect(resolved.has("C4")).toBe(false); // 提示档无修复动作
    expect(fs.existsSync(missing)).toBe(false); // --fix 后仍不存在
    expect(deriveExitCode(report.results)).toBe(1);
  });

  it("存在且可写 → ✅;不可写 → ❌", async () => {
    const dir = path.join(home, "work");
    fs.mkdirSync(dir, { recursive: true });
    const ok = await doctorReport({ workdir: dir });
    expect(resultById(ok.report, "C4")?.severity).toBe("ok");
    expect(deriveExitCode(ok.report.results.filter((r) => r.id !== "C4"))).toBe(0);

    const locked = path.join(home, "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500); // r-x:不可写
    try {
      const bad = await doctorReport({ workdir: locked });
      expect(resultById(bad.report, "C4")?.severity).toBe("fail");
    } finally {
      fs.chmodSync(locked, 0o700); // 还原以便清理
    }
  });

  it("多项目:一个坏 workdir ❌,其他项目照常 ✅,互不掩盖", async () => {
    const good = path.join(home, "proj-good");
    fs.mkdirSync(good, { recursive: true });
    const { report } = await doctorReport({
      workdir: good,
      multiProject: true,
      projects: {
        "!roomGood": { name: "good", workdir: good },
        "!roomBad": { name: "bad", workdir: path.join(home, "proj-missing") },
      },
    });
    const items = report.results.filter((r) => r.id.startsWith("C4"));
    expect(items.length).toBeGreaterThanOrEqual(3); // 默认 + 两个项目
    const byId = new Map(items.map((r) => [r.id, r]));
    expect([...byId.values()].some((r) => r.severity === "ok")).toBe(true);
    const bad = [...byId.values()].find((r) => r.severity === "fail");
    expect(bad).toBeDefined();
    expect(bad!.detail).toContain("proj-missing");
    expect(deriveExitCode(report.results)).toBe(1);
  });

  it("未配置 workdir 且默认根缺失 → ⚠️(提示,不挡 CI)", async () => {
    const { report } = await doctorReport({});
    const c4 = resultById(report, "C4");
    expect(c4?.severity).toBe("warn");
    expect(c4?.nextStep).toBeTruthy();
  });
});

describe("C5 — proxy scheme(resolveProxySettings 同源)", () => {
  it("socks5:// → ❌(同源校验错误);http:// → ✅;未配置 → ✅ 直连", async () => {
    const bad = await doctorReport({ proxy: "socks5://127.0.0.1:1080" });
    const c5 = resultById(bad.report, "C5");
    expect(c5?.severity).toBe("fail");
    expect(deriveExitCode(bad.report.results)).toBe(1);

    const good = await doctorReport({ proxy: "http://127.0.0.1:8080" });
    expect(resultById(good.report, "C5")?.severity).toBe("ok");

    const none = await doctorReport({});
    expect(resultById(none.report, "C5")?.severity).toBe("ok");
  });
});

describe("C6 — sessionDir 存在且可写", () => {
  it("配置存在可写 → ✅;缺失 → ❌ 且 --fix 不代建;未配置 → ✅", async () => {
    const dir = path.join(home, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const ok = await doctorReport({ sessionDir: dir });
    expect(resultById(ok.report, "C6")?.severity).toBe("ok");

    const missing = path.join(home, "no-such-sessions");
    const bad = await doctorReport({ sessionDir: missing });
    const c6 = resultById(bad.report, "C6");
    expect(c6?.severity).toBe("fail");
    const { resolved } = await fixCurrent(bad.deps, bad.report);
    expect(resolved.has("C6")).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);

    const unset = await doctorReport({});
    expect(resultById(unset.report, "C6")?.severity).toBe("ok");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D 组:状态与目录
// ════════════════════════════════════════════════════════════════════════════

describe("D1/D2 — 自管目录存在与权限", () => {
  it("缺失 → ⚠️,--fix 创建并 0700(安全幂等档)", async () => {
    const { report, deps } = await doctorReport({ workdir: home });
    const d1 = resultById(report, "D1");
    const d2 = resultById(report, "D2");
    expect(d1?.severity).toBe("warn");
    expect(d2?.severity).toBe("warn");
    expect(fs.existsSync(stateDir())).toBe(false);
    expect(fs.existsSync(layout().dataDir)).toBe(false);

    const { printed, resolved } = await fixCurrent(deps, report);
    expect(resolved.has("D1") && resolved.has("D2")).toBe(true);
    expect(fs.existsSync(stateDir())).toBe(true);
    expect(fs.existsSync(layout().dataDir)).toBe(true);
    expect(fileMode(stateDir())).toBe("700");
    expect(fileMode(layout().dataDir)).toBe("700");
    expect(printed.join("\n")).toContain("已修复");
    // 幂等:再跑一遍全 ✅ 无动作
    const again = await doctorReport({ workdir: home });
    expect(resultById(again.report, "D1")?.severity).toBe("ok");
    expect(resultById(again.report, "D2")?.severity).toBe("ok");
  });

  it("权限过松(0755)→ ⚠️,--fix 收紧 0700;win32 权限 ⏭️ 存在性照查", async () => {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o755 });
    fs.chmodSync(stateDir(), 0o755);
    const { report, deps } = await doctorReport({ workdir: home });
    expect(resultById(report, "D1")?.severity).toBe("warn");
    await fixCurrent(deps, report);
    expect(fileMode(stateDir())).toBe("700");

    // 先例 config-win32:平台翻转、布局保持 POSIX 形(同一目录,权限档才生效)
    const deps32 = makeHarness({
      platform: "win32",
      homedir: home,
      layout: makeDoctorLayout("linux", home),
      env: process.env,
    });
    const report32 = await runDoctor(deps32, NO_FIX);
    expect(resultById(report32, "D1")?.severity).toBe("skip");
    expect(resultById(report32, "D1")?.summary).toContain("无法确认");
    expect(fs.existsSync(stateDir())).toBe(true); // 存在性照查不误报
  });
});

describe("D3 — 陈旧单实例锁(lockIsStale 同源)", () => {
  /** 造一把锁:pid 为给定值。 */
  function writeLock(pid: number): string {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const lockPath = layout().lockPath;
    fs.writeFileSync(lockPath, `${pid}:test-owner`, { mode: 0o600 });
    return lockPath;
  }

  it("死进程锁 → ⚠️,--fix 清掉,幂等无二次伤害", async () => {
    // 拿一个必然已退出的 pid
    const dead = spawnSync("true").pid ?? 999999;
    const lockPath = writeLock(dead);
    const { report, deps } = await doctorReport({ workdir: home });
    const d3 = resultById(report, "D3");
    expect(d3?.severity).toBe("warn");
    expect(d3?.summary).toContain("陈旧单实例锁");

    const { resolved } = await fixCurrent(deps, report);
    expect(resolved.has("D3")).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    // 幂等:锁已不在,再跑 ✅
    const again = await doctorReport({ workdir: home });
    expect(resultById(again.report, "D3")?.severity).toBe("ok");
  });

  it("活进程锁 → ✅(有实例持有,doctor 不拿锁不偷锁)", async () => {
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore", detached: true }); // 活进程
    sleeper.unref();
    try {
      writeLock(sleeper.pid ?? 999999);
      const { report } = await doctorReport({ workdir: home });
      const d3 = resultById(report, "D3");
      expect(d3?.severity).toBe("ok");
      expect(fs.existsSync(layout().lockPath)).toBe(true);
    } finally {
      try {
        process.kill(sleeper.pid!, "SIGKILL");
      } catch {
        // 已退出,无碍
      }
    }
  });

  it("无锁 → ✅(空闲)", async () => {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const { report } = await doctorReport({ workdir: home });
    expect(resultById(report, "D3")?.severity).toBe("ok");
  });
});

describe("D4/D5 — manual-stop 标记与 pending-update 残留", () => {
  it("watchdog-paused 残留 → ⚠️,--fix 清掉,幂等", async () => {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const marker = path.join(stateDir(), "watchdog-paused");
    fs.writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
    const { report, deps } = await doctorReport({ workdir: home });
    const d4 = resultById(report, "D4");
    expect(d4?.severity).toBe("warn");
    expect(d4?.summary).toContain("人工停止标记");

    await fixCurrent(deps, report);
    expect(fs.existsSync(marker)).toBe(false);
    const again = await doctorReport({ workdir: home });
    expect(resultById(again.report, "D4")?.severity).toBe("ok");
  });

  it("pending-update 残留(有效条目)→ ⚠️,--fix 清掉;畸形条目同样报出;无文件 ✅", async () => {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const pendingPath = path.join(stateDir(), "pending-update.json");
    fs.writeFileSync(
      pendingPath,
      JSON.stringify({ from: "1.7.4", to: "1.7.5", startedAt: Date.now() }),
      { mode: 0o600 },
    );
    const { report, deps } = await doctorReport({ workdir: home });
    const d5 = resultById(report, "D5");
    expect(d5?.severity).toBe("warn");
    expect(d5?.summary).toContain("pending-update");

    await fixCurrent(deps, report);
    expect(fs.existsSync(pendingPath)).toBe(false);
    const again = await doctorReport({ workdir: home });
    expect(resultById(again.report, "D5")?.severity).toBe("ok");

    // 畸形条目:文件在、内容坏 → 仍报 ⚠️ 且可清
    fs.writeFileSync(pendingPath, "{ broken", { mode: 0o600 });
    const badReport = await doctorReport({ workdir: home });
    expect(resultById(badReport.report, "D5")?.severity).toBe("warn");
    await fixCurrent(badReport.deps, badReport.report);
    expect(fs.existsSync(pendingPath)).toBe(false);
  });
});

describe("D6 — 旧布局残留(只报告 + 迁移指引,不悄悄忽略)", () => {
  it("旧布局文件在 → ⚠️ + 指引;--fix 后原样(数据迁移交给启动迁移器)", async () => {
    const legacyStore = path.join(home, ".pi", "pi-courier-matrix-store.json");
    fs.mkdirSync(path.dirname(legacyStore), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyStore, "{}", { mode: 0o600 });
    const { report, deps } = await doctorReport({ workdir: home });
    const d6 = resultById(report, "D6");
    expect(d6?.severity).toBe("warn");
    expect(d6?.summary).toContain("旧布局残留");
    expect(d6?.nextStep).toBeTruthy();

    await fixCurrent(deps, report);
    expect(fs.existsSync(legacyStore)).toBe(true); // 残留仍在(不代迁移)
  });

  it("无残留 → ✅", async () => {
    const { report } = await doctorReport({ workdir: home });
    expect(resultById(report, "D6")?.severity).toBe("ok");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 三档边界与降级
// ════════════════════════════════════════════════════════════════════════════

describe("禁区档 — --fix 永不碰 trustedUsers 与 session/数据", () => {
  it("混合现场 --fix:trustedUsers 逐字节原样,sessionDir 内容原样,workdir 不被建", async () => {
    const workdirMissing = path.join(home, "no-workdir");
    const sessionDir = path.join(home, "sess");
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessionDir, "session.json"), '{"keep": true}', { mode: 0o600 });
    const config = {
      auth: { trustedUsers: ["@barry:hs.example"] },
      workdir: workdirMissing,
      sessionDir,
    };
    writeConfig(config);
    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env });
    const report = await runDoctor(deps, NO_FIX);
    const { io, exits } = makeDoctorIO({ isTTY: true });
    const askYesNo = vi.fn(async (_q: string) => true);
    await doctorShell(["--fix"], layout(), { ...io, askYesNo });

    // trustedUsers 原样
    expect((JSON.parse(fs.readFileSync(configPath(), "utf-8")) as typeof config).auth?.trustedUsers).toEqual([
      "@barry:hs.example",
    ]);
    // session 数据原样
    expect(fs.readFileSync(path.join(sessionDir, "session.json"), "utf-8")).toBe('{"keep": true}');
    // workdir 未被代建
    expect(fs.existsSync(workdirMissing)).toBe(false);
    expect(exits).toEqual([1]); // workdir 的 ❌ 仍在(提示档未修)
  });
});

describe("降级 — C/D 组 helper 加载抛错", () => {
  afterEach(() => {
    vi.doUnmock("../src/proxy.js");
    vi.doUnmock("../src/lock.js");
  });

  it("proxy.js 抛错 → C5 ⏭️;lock.js 抛错 → D3 ⏭️;退出码按剩余 ❌ 派生,doctor 不崩", async () => {
    writeConfig({ workdir: home, proxy: "http://127.0.0.1:8080" });
    // 留一个 workdir 缺失的 ❌(fs-only),验证退出码不被降级稀释
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
    cfg.workdir = path.join(home, "no-such");
    writeConfig(cfg);
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout().lockPath, `1:dead-owner`, { mode: 0o600 });

    vi.resetModules();
    vi.doMock("../src/proxy.js", () => {
      throw new Error("proxy helper exploded");
    });
    vi.doMock("../src/lock.js", () => {
      throw new Error("lock helper exploded");
    });
    const { runDoctor: freshRunDoctor } = await import("../src/doctor/run.js");
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    const { setRuntimeLayoutForTests: pinFresh } = await import("../src/config.js");
    pinFresh(makeDoctorLayout("linux", home), home);

    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env });
    const report = await freshRunDoctor(deps, NO_FIX);
    const c5 = resultById(report, "C5");
    const d3 = resultById(report, "D3");
    expect(c5?.severity).toBe("skip");
    expect(c5?.summary).toContain("无法确认");
    expect(d3?.severity).toBe("skip");
    expect(d3?.summary).toContain("无法确认");
    // workdir ❌(fs-only)照查 → 退出码 1
    expect(resultById(report, "C4")?.severity).toBe("fail");
    expect(deriveExitCode(report.results)).toBe(1);
  });
});
