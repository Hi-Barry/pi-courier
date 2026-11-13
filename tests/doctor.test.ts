/**
 * doctor 骨架测试(spec #337 票 #338)。
 *
 * 只测外部行为:经 DoctorDeps 注入临时目录布局 + fake 依赖,断言报告与
 * 退出码;渲染/退出码/脱敏是纯函数,直接断言(票 1 验收明示)。降级测试
 * 用 vi.doMock 模拟既有 helper 动态 import 抛错 —— 放在文件末尾,防止 mock
 * 泄漏进其他用例(每个用例 doUnmock 自清理)。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeLayoutForTests } from "../src/config.js";
import type { DoctorShellIO } from "../src/doctor/shell.js";
import { doctorShell } from "../src/doctor/shell.js";
import {
  buildJsonReport,
  countSeverities,
  deriveExitCode,
  groupResults,
  maskSecrets,
  renderHuman,
  renderJson,
  sortResults,
} from "../src/doctor/report.js";
import { guardCheck, runDoctor } from "../src/doctor/run.js";
import type { DoctorDeps, DoctorReport } from "../src/doctor/types.js";
import type { DoctorShellResult } from "./doctor-harness.js";
import { FIXED_NOW, makeDoctorLayout, makeHarness } from "./doctor-harness.js";
import { resolveLayout } from "../src/paths.js";
import zh from "../src/i18n/zh.js";

// ── 退出码派生(纯函数,表驱动)──────────────────────────────────────────

describe("deriveExitCode — 退出码派生表驱动(spec 严重度契约)", () => {
  const r = (severity: "ok" | "warn" | "fail" | "skip") => ({
    id: "B1",
    group: "B" as const,
    severity,
    summary: "x",
  });

  it("全 ✅ → 0", () => {
    expect(deriveExitCode([r("ok"), r("ok")])).toBe(0);
  });

  it("仅 ⚠️ → 0(CI 不把风险项当失败)", () => {
    expect(deriveExitCode([r("ok"), r("warn"), r("warn")])).toBe(0);
  });

  it("⏭️ 不抬退出码(无法确认 ≠ 坏)", () => {
    expect(deriveExitCode([r("skip"), r("ok")])).toBe(0);
  });

  it("含 ❌ → 1", () => {
    expect(deriveExitCode([r("ok"), r("warn"), r("fail")])).toBe(1);
    expect(deriveExitCode([r("fail")])).toBe(1);
  });

  it("空检查集 → 0(骨架可跑通)", () => {
    expect(deriveExitCode([])).toBe(0);
  });
});

// ── 渲染 golden(纯函数)───────────────────────────────────────────────

/** 固定输入的 golden 报告(文案以 zh 表为锚,tests/setup.ts 已 setLocale("zh"))。 */
function goldenReport(results: DoctorReport["results"]): DoctorReport {
  return {
    version: "1.7.5",
    generatedAt: "2026-11-13T08:00:00.000Z",
    platform: "linux",
    offline: false,
    results,
  };
}

const okResult = {
  id: "B1",
  group: "B" as const,
  severity: "ok" as const,
  summary: "pi CLI 解析正常",
  detail: "/usr/local/bin/pi → /usr/lib/node_modules/pi/cli.js",
};

describe("renderHuman — TTY 人话报告 golden", () => {
  it("健康布局(全 ✅):报告头带版本号、按组列出、尾部汇总", () => {
    const healthy = goldenReport([
      okResult,
      { id: "C1", group: "C", severity: "ok", summary: "配置文件可读且合法" },
    ]);
    expect(renderHuman(healthy)).toBe(
      [
        "pi-courier doctor v1.7.5 — 2026-11-13(linux)",
        "",
        "B · pi 解析链",
        "  ✅ B1 pi CLI 解析正常",
        "     ↳ /usr/local/bin/pi → /usr/lib/node_modules/pi/cli.js",
        "",
        "C · pi-courier 配置",
        "  ✅ C1 配置文件可读且合法",
        "",
        "汇总: 2 ✅ · 0 ⚠️ · 0 ❌ · 0 ⏭️",
      ].join("\n"),
    );
  });

  it("⚠️/❌/⏭️ 混合布局:符号、细节、下一步、汇总行 golden", () => {
    const mixed = goldenReport([
      okResult,
      {
        id: "C2",
        group: "C",
        severity: "warn",
        summary: "配置文件权限过松",
        detail: "0644,应为 0600",
        nextStep: "pi-courier doctor --fix",
      },
      {
        id: "C3",
        group: "C",
        severity: "fail",
        summary: "workdir 缺失",
        nextStep: "mkdir -p ~/Projects",
      },
      {
        id: "D1",
        group: "D",
        severity: "skip",
        summary: "无法确认:helper 加载失败",
      },
    ]);
    expect(renderHuman(mixed)).toBe(
      [
        "pi-courier doctor v1.7.5 — 2026-11-13(linux)",
        "",
        "B · pi 解析链",
        "  ✅ B1 pi CLI 解析正常",
        "     ↳ /usr/local/bin/pi → /usr/lib/node_modules/pi/cli.js",
        "",
        "C · pi-courier 配置",
        "  ⚠️ C2 配置文件权限过松",
        "     ↳ 0644,应为 0600",
        "     ↳ 下一步: pi-courier doctor --fix",
        "  ❌ C3 workdir 缺失",
        "     ↳ 下一步: mkdir -p ~/Projects",
        "",
        "D · 状态与目录",
        "  ⏭️ D1 无法确认:helper 加载失败",
        "",
        "汇总: 1 ✅ · 1 ⚠️ · 1 ❌ · 1 ⏭️",
      ].join("\n"),
    );
  });

  it("空检查集:占位说明 + 全零汇总(骨架可跑通)", () => {
    expect(renderHuman(goldenReport([]))).toBe(
      [
        "pi-courier doctor v1.7.5 — 2026-11-13(linux)",
        "(本版本未装配检查项 —— 骨架运行)",
        "",
        "汇总: 0 ✅ · 0 ⚠️ · 0 ❌ · 0 ⏭️",
      ].join("\n"),
    );
  });

  it("--offline 报告头下带跳过说明行", () => {
    const report = { ...goldenReport([]), offline: true };
    expect(renderHuman(report).split("\n")[1]).toBe("⏭️ --offline:网络检查已整组跳过");
  });

  it("渲染按组排序且组内 id 自然序(B10 排在 B2 后)", () => {
    const report = goldenReport([
      { id: "C10", group: "C", severity: "ok", summary: "十号" },
      { id: "B2", group: "B", severity: "ok", summary: "二号" },
      { id: "B10", group: "B", severity: "ok", summary: "十号" },
      { id: "A1", group: "A", severity: "ok", summary: "一号" },
    ]);
    const groups = groupResults(report.results).map(([group, items]) => [group, items.map((i) => i.id)]);
    expect(groups).toEqual([
      ["A", ["A1"]],
      ["B", ["B2", "B10"]],
      ["C", ["C10"]],
    ]);
    expect(sortResults(report.results).map((r) => r.id)).toEqual(["A1", "B2", "B10", "C10"]);
  });
});

describe("renderJson / buildJsonReport — 机器可读 golden", () => {
  it("JSON 形态可解析且结构与 summary 同源(脱敏后)", () => {
    const report = goldenReport([
      okResult,
      {
        id: "B2",
        group: "B",
        severity: "fail",
        summary: "配置里的 pi 路径失效",
        detail: "cliPath: /opt/old-pi/cli.js",
        nextStep: "pi-courier doctor --fix",
      },
    ]);
    const parsed = JSON.parse(renderJson(report));
    expect(parsed.version).toBe("1.7.5");
    expect(parsed.generatedAt).toBe("2026-11-13T08:00:00.000Z");
    expect(parsed.platform).toBe("linux");
    expect(parsed.offline).toBe(false);
    expect(parsed.results).toEqual([
      { id: "B1", group: "B", severity: "ok", summary: "pi CLI 解析正常", detail: "/usr/local/bin/pi → /usr/lib/node_modules/pi/cli.js" },
      {
        id: "B2",
        group: "B",
        severity: "fail",
        summary: "配置里的 pi 路径失效",
        detail: "cliPath: /opt/old-pi/cli.js",
        nextStep: "pi-courier doctor --fix",
      },
    ]);
    expect(parsed.summary).toEqual(countSeverities(report.results));
    expect(buildJsonReport(report).summary).toEqual({ ok: 1, warn: 0, fail: 1, skip: 0 });
  });
});

describe("maskSecrets — 脱敏(报告与 JSON 均不出现完整 token,最多露前 4 位)", () => {
  it("syt_ 前缀 Matrix token:只留前 4 位", () => {
    const token = "syt_dGVzdHRva2VuX3NlY3JldF90b2tlbg";
    const masked = maskSecrets(`accessToken: ${token}`);
    expect(masked).not.toContain(token);
    expect(masked).toContain("syt_****");
  });

  it("URL 查询参数凭据:值整段打码", () => {
    const masked = maskSecrets("GET https://hs.example/_matrix/client/v3/account/whoami?access_token=abc123verysecret");
    expect(masked).toContain("access_token=****");
    expect(masked).not.toContain("abc123verysecret");
  });

  it("URL userinfo 密码:保留用户名,打掉密码", () => {
    const masked = maskSecrets("proxy http://alice:secretpw@proxy.example:8080");
    expect(masked).toContain("alice:****@proxy.example:8080");
    expect(masked).not.toContain("secretpw");
  });

  it("≥24 字符含数字的不透明串(老式 token 兜底):只留前 4 位", () => {
    const masked = maskSecrets("token9ab cDEFGHIJKLMNOPQRSTUVWXYZ123456 tail");
    expect(masked).not.toContain("cDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(masked).toContain("cDEF****");
  });

  it("正常文案不误伤:包名/长英文词/短串原样保留", () => {
    const text = "@earendil-works/pi-coding-agent dist/bundle/cli.js node_modules internationalization";
    expect(maskSecrets(text)).toBe(text);
  });

  it("golden 断言渗透:含 token 的 detail 在人话与 JSON 中都不露完整值", () => {
    const token = "syt_dGVzdHRva2VuX3NlY3JldF90b2tlbg";
    const report = goldenReport([
      { id: "C1", group: "C", severity: "warn", summary: `accessToken 已配置(${token})` },
    ]);
    const human = renderHuman(report);
    const json = renderJson(report);
    expect(human).not.toContain(token);
    expect(json).not.toContain(token);
    expect(human).toContain("syt_****");
    expect(json).toContain("syt_****");
  });
});

// ── 单项守卫(guardCheck):抛错 = 无法确认 → ⏭️ ──────────────────────────

describe("guardCheck — 检查项抛错降级 ⏭️,退出码按剩余 ❌ 派生", () => {
  it("检查项抛错 → 单条 ⏭️,id 保留,原因进文案", async () => {
    const results = await guardCheck({
      id: "B2",
      group: "B",
      run: async () => {
        throw new Error("helper exploded");
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "B2", group: "B", severity: "skip" });
    expect(results[0]!.summary).toContain("无法确认");
    expect(results[0]!.summary).toContain("helper exploded");
  });

  it("检查项正常返回单项/多项 → 原样收集", async () => {
    const single = await guardCheck({
      id: "C1",
      group: "C",
      run: async () => ({ id: "C1", group: "C", severity: "ok", summary: "s" }),
    });
    expect(single).toEqual([{ id: "C1", group: "C", severity: "ok", summary: "s" }]);
    const multi = await guardCheck({
      id: "C5",
      group: "C",
      run: async () => [
        { id: "C5.1", group: "C" as const, severity: "ok" as const, summary: "a" },
        { id: "C5.2", group: "C" as const, severity: "fail" as const, summary: "b" },
      ],
    });
    expect(multi.map((r) => r.id)).toEqual(["C5.1", "C5.2"]);
  });

  it("降级 ⏭️ 不抬退出码,剩余 ❌ 照派生 1(组合断言)", async () => {
    const degraded = await guardCheck({
      id: "E1",
      group: "E",
      run: async () => {
        throw new Error("network unreachable");
      },
    });
    const failing = { id: "C1", group: "C" as const, severity: "fail" as const, summary: "s" };
    expect(deriveExitCode([...degraded, failing])).toBe(1);
    expect(deriveExitCode(degraded)).toBe(0);
  });
});

// ── runDoctor(注入 fake 依赖;真实 helper)─────────────────────────────

describe("runDoctor — 最小检查集与降级", () => {
  let home: string;
  let cleanupLayout: () => void;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-doctor-")));
    // 配置隔离:loadConfig(readBridgeVersion 同文件族)的布局钉进临时家目录,
    // 测试不读真实用户配置(先例 tests/config-win32.test.ts 的注入缝)。
    const layout = makeDoctorLayout("linux", home);
    setRuntimeLayoutForTests(layout, home);
    // 健康基线(票 #340 起 C1 配置缺失是 ❌、D1/D2 缺失是 ⚠️):最小配置 +
    // 预建自管目录,让「无 ❌ 退出 0」的骨架断言不被环境噪声稀释。
    fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(layout.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.configPath, JSON.stringify({ workdir: home }, null, 2), { mode: 0o600 });
    cleanupLayout = () => setRuntimeLayoutForTests(undefined);
  });

  afterEach(() => {
    cleanupLayout();
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("最小检查集(B 组)可跑通:报告产出、无 ❌、报告头带真实版本号与注入时钟", async () => {
    const deps = makeHarness({ platform: "linux", homedir: home });
    const report = await runDoctor(deps, { fix: false, json: false, offline: false });
    // B/C/D 组已注册(#339/#340):健康基线下 B1 skip(未配置)/其余全部非 ❌
    // (B2 经 peer 兜底解析;C5 直连;D 组目录已预建)。
    expect(report.results.map((r) => r.id)).toEqual([
      "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "C5", "C6", "D1", "D2", "D3", "D4", "D5", "D6",
    ]);
    expect(report.results.some((r) => r.severity === "fail")).toBe(false);
    expect(deriveExitCode(report.results)).toBe(0);
    expect(report.platform).toBe("linux");
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8")) as {
      version: string;
    };
    expect(report.version).toBe(pkg.version);
    // generatedAt 来自注入的 now(harness 固定时钟),不是真实 Date.now()。
    expect(report.generatedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("platform win32 注入:平台分支路径可跑通(F 组跳过逻辑随票 #342)", async () => {
    // 先例 config-win32.test.ts:平台翻转、布局保持 POSIX 形(同一基线目录)。
    // C3/D1/D2 的权限档在 win32 落 ⏭️(等价语义缺失),其余照查不误报。
    const deps = makeHarness({
      platform: "win32",
      homedir: home,
      layout: makeDoctorLayout("linux", home),
    });
    const report = await runDoctor(deps, { fix: false, json: false, offline: false });
    expect(report.platform).toBe("win32");
    expect(deriveExitCode(report.results)).toBe(0);
    expect(renderHuman(report)).toContain("(win32)");
  });
});

// ── doctorShell 薄壳(flags/渲染/退出码/非 TTY/崩溃)──────────────────────

describe("doctorShell — CLI 分发薄壳", () => {
  let home: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-doctor-shell-")));
    // 健康基线(同 runDoctor describe):最小配置 + 预建自管目录,
    // 「无 ❌ 退出 0」断言不被票 #340 的环境项(C1 配置缺失 ❌)稀释。
    const layout = makeDoctorLayout("linux", home);
    setRuntimeLayoutForTests(layout, home);
    fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(layout.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.configPath, JSON.stringify({ workdir: home }, null, 2), { mode: 0o600 });
  });

  afterEach(() => {
    setRuntimeLayoutForTests(undefined);
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function shellHarness(options: { isTTY?: boolean; writeThrows?: Error } = {}): {
    io: DoctorShellIO;
    writes: string[];
    errors: string[];
    exits: number[];
  } {
    const writes: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const io: DoctorShellIO = {
      isTTY: () => options.isTTY ?? false,
      write: (text) => {
        if (options.writeThrows) throw options.writeThrows;
        writes.push(text);
      },
      error: (text) => errors.push(text),
      exit: (code) => exits.push(code),
    };
    return { io, writes, errors, exits };
  }

  it("--json 最小检查集:stdout 是纯 JSON(可 jq 解析)、无 ❌ 退出 0、无提问", async () => {
    const { io, writes, exits } = shellHarness();
    await doctorShell(["--json"], makeDoctorLayout("linux", home), io);
    expect(exits).toEqual([0]);
    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]!) as DoctorShellResult;
    expect(parsed.results.map((r) => r.id)).toEqual([
      "B1", "B2", "B3", "B4", "C1", "C2", "C3", "C4", "C5", "C6", "D1", "D2", "D3", "D4", "D5", "D6",
    ]);
    expect(parsed.summary.fail).toBe(0);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8")) as {
      version: string;
    };
    expect(parsed.version).toBe(pkg.version);
    // 非 TTY(isTTY=false)下零提问、正常退出:唯一的 stdout 输出就是 JSON 本体。
  });

  it("人话输出(默认):报告头带版本号与日期,无 ❌", async () => {
    const { io, writes, exits } = shellHarness();
    await doctorShell([], makeDoctorLayout("linux", home), io);
    expect(exits).toEqual([0]);
    expect(writes[0]).toContain("pi-courier doctor v");
    expect(writes[0]).toMatch(/— \d{4}-\d{2}-\d{2}\(linux\)/);
    expect(writes[0]).toContain("B · pi 解析链");
    expect(writes[0]).toContain("0 ❌"); // 无失败项(计数行其他档随环境浮动)
  });

  it("未知参数:报错退出 1,不产出报告", async () => {
    const { io, writes, errors, exits } = shellHarness();
    await doctorShell(["--deep"], makeDoctorLayout("linux", home), io);
    expect(exits).toEqual([1]);
    expect(writes).toEqual([]);
    expect(errors.join("\n")).toContain("--deep");
  });

  it("doctor 自身崩溃(渲染输出抛异常)→ 退出码 2 + 崩溃文案", async () => {
    const { io, writes, errors, exits } = shellHarness({
      writeThrows: new Error("sink exploded"),
    });
    await doctorShell([], makeDoctorLayout("linux", home), io);
    expect(exits).toEqual([2]);
    expect(writes).toEqual([]);
    expect(errors.join("\n")).toContain("doctor 自身崩溃");
    expect(errors.join("\n")).toContain("sink exploded");
  });
});

// ── parseDoctorArgs(纯决策,表驱动)────────────────────────────────────

describe("parseDoctorArgs — 三个开关与未知参数", () => {
  it("三开关单独与组合解析", async () => {
    const { parseDoctorArgs } = await import("../src/doctor/types.js");
    expect(parseDoctorArgs([])).toEqual({ ok: true, options: { fix: false, json: false, offline: false } });
    expect(parseDoctorArgs(["--fix"])).toEqual({ ok: true, options: { fix: true, json: false, offline: false } });
    expect(parseDoctorArgs(["--json"])).toEqual({ ok: true, options: { fix: false, json: true, offline: false } });
    expect(parseDoctorArgs(["--offline"])).toEqual({ ok: true, options: { fix: false, json: false, offline: true } });
    expect(parseDoctorArgs(["--fix", "--json", "--offline"])).toEqual({
      ok: true,
      options: { fix: true, json: true, offline: true },
    });
  });

  it("未知 flag 与位置参数一律报错(打错的 flag 静默忽略比报错更危险)", async () => {
    const { parseDoctorArgs } = await import("../src/doctor/types.js");
    const bad1 = parseDoctorArgs(["--only", "B1"]);
    expect(bad1.ok).toBe(false);
    const bad2 = parseDoctorArgs(["extra"]);
    expect(bad2.ok).toBe(false);
    if (!bad2.ok) expect(bad2.message).toContain("extra");
  });
});

// ── i18n 双表(zh 键集基准,新文案断言以 zh 表为锚)────────────────────────

describe("doctor i18n — zh 基准锚点", () => {
  it("zh 表含骨架文案且逐字锚定", () => {
    expect(zh["doctor.reportHeader"]).toBe("pi-courier doctor v{version} — {date}({platform})");
    expect(zh["doctor.summary"]).toBe("汇总: {ok} ✅ · {warn} ⚠️ · {fail} ❌ · {skip} ⏭️");
    expect(zh["doctor.degraded"]).toBe("无法确认:{reason}");
    expect(zh["doctor.crashed"]).toContain("退出码 2");
    expect(zh["doctor.group.B"]).toBe("B · pi 解析链");
    // en 表键集对齐由 tests/i18n.test.ts 的既有键集测试覆盖(新增键自动纳入)。
  });

  it("八组检查项的组标题键齐全", () => {
    for (const g of ["A", "B", "C", "D", "E", "F", "G", "H"] as const) {
      expect(zh[`doctor.group.${g}`]).toBeTruthy();
    }
  });
});

// ── 降级(既有 helper 动态 import 抛错;放文件末尾防 mock 泄漏)─────────────

describe("降级 — 既有 helper 动态 import 抛错", () => {
  let home: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-doctor-degrade-")));
    // 健康基线(票 #340 起 C1 配置缺失是 ❌):避免环境项稀释退出码断言
    const layout = makeDoctorLayout("linux", home);
    setRuntimeLayoutForTests(layout, home);
    fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(layout.configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.configPath, JSON.stringify({ workdir: home }, null, 2), { mode: 0o600 });
  });

  afterEach(() => {
    setRuntimeLayoutForTests(undefined);
    vi.doUnmock("../src/version.js");
    vi.doUnmock("../src/doctor/checks.js");
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("readBridgeVersion 加载抛错 → 报告头降级 unknown,doctor 不崩、退出码仍可派生", async () => {
    vi.resetModules();
    vi.doMock("../src/version.js", () => {
      throw new Error("version helper exploded");
    });
    const { runDoctor: freshRunDoctor } = await import("../src/doctor/run.js");
    // vi.resetModules 后是新模块注册表:i18n 单例回到默认 en,重新钉回 zh
    // (与 tests/setup.ts 同锚;文案断言以 zh 表为准)。
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    const deps: DoctorDeps = makeHarness({ platform: "linux", homedir: home });
    const report = await freshRunDoctor(deps, { fix: false, json: false, offline: false });
    expect(report.version).toBe("unknown");
    expect(deriveExitCode(report.results)).toBe(0);
    expect(renderHuman(report)).toContain("vunknown");
  });

  it("checks 清单收集抛错 → 整份降级 ⏭️(每组一项),退出码 0,doctor 不崩", async () => {
    vi.resetModules();
    vi.doMock("../src/doctor/checks.js", () => ({
      collectCheckEntries: () => {
        throw new Error("registry exploded");
      },
    }));
    const { runDoctor: freshRunDoctor } = await import("../src/doctor/run.js");
    const { setLocale } = await import("../src/i18n/index.js");
    setLocale("zh");
    const deps: DoctorDeps = makeHarness({ platform: "linux", homedir: home });
    const report = await freshRunDoctor(deps, { fix: false, json: false, offline: false });
    const skipIds = report.results.filter((r) => r.severity === "skip").map((r) => r.id);
    expect(skipIds).toEqual(["A0", "B0", "C0", "D0", "E0", "F0", "G0", "H0"]);
    expect(deriveExitCode(report.results)).toBe(0);
    expect(renderHuman(report)).toContain("无法确认:registry exploded");
  });
});
