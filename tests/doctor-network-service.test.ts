/**
 * doctor 票 #342 测试:E 组(网络,--offline 跳过整组,5 秒超时判 ⏭️)与
 * F 组(服务,仅 Linux,只读 systemctl 对比;win32 整组 ⏭️)。
 *
 * E 组经注入 fetch 三态表驱动(立即成功/立即失败/永不 resolve);超时用
 * vitest fake timers 推进 5 秒上限。F 组经注入 execFile,断言只收到
 * cat/is-enabled/is-active 只读查询 —— 绝不写 unit、绝不启停。
 */
import * as fs from "node:fs";
import * as nodeOs from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeLayoutForTests } from "../src/config.js";
import { deriveExitCode } from "../src/doctor/report.js";
import { runDoctor } from "../src/doctor/run.js";
import { renderHuman } from "../src/doctor/report.js";
import type { CheckResult, DoctorDeps } from "../src/doctor/types.js";
import { makeDoctorLayout, makeHarness } from "./doctor-harness.js";

// ── harness ─────────────────────────────────────────────────────────────────

let home: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(nodeOs.tmpdir(), "pi-courier-doctor-ef-")));
  savedEnv = { ...process.env };
  const layout = makeDoctorLayout("linux", home);
  setRuntimeLayoutForTests(layout, home);
  fs.mkdirSync(layout.stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(layout.configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(layout.configPath, JSON.stringify({ workdir: home }, null, 2), { mode: 0o600 });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("PI_")) delete process.env[k];
  }
});

afterEach(() => {
  process.env = savedEnv;
  setRuntimeLayoutForTests(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const NO_FIX = { fix: false, json: false, offline: false } as const;

function resultById(report: { results: CheckResult[] }, id: string): CheckResult | undefined {
  return report.results.find((r) => r.id === id);
}

/** Matrix 配置写入(homeserver + token)。 */
function writeMatrixConfig(proxy?: string): void {
  const cfgPath = makeDoctorLayout("linux", home).configPath;
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        workdir: home,
        matrix: { homeserverUrl: "https://hs.example", accessToken: "syt_dGVzdHRva2VuX3NlY3JldA" },
        ...(proxy ? { proxy } : {}),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/** 构造 fake fetch:按 URL 分类返回三态之一。 */
type FetchFake = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function fakeFetch(
  handler: (url: string) => "ok" | "fail" | "hang" | Response,
): FetchFake & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((url: string | URL | Request) => {
    const urlText = typeof url === "string" ? url : url.toString();
    calls.push(urlText);
    const outcome = handler(urlText);
    if (typeof outcome === "string") {
      if (outcome === "hang") return new Promise<Response>(() => {});
      throw new Error("connect ECONNREFUSED");
    }
    return Promise.resolve(outcome);
  }) as FetchFake & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// ════════════════════════════════════════════════════════════════════════════
// E 组:网络(whoami / homeserver / 代理)
// ════════════════════════════════════════════════════════════════════════════

describe("E 组 — 网络检查(注入 fetch 三态)", () => {
  it("whoami 200 → ✅;401 → ❌ 凭据无效;连接拒绝 → ❌", async () => {
    writeMatrixConfig();
    const ok = await doctorReport(fakeFetch(() => jsonResponse(200, { user_id: "@bot:hs.example" })));
    expect(resultById(ok.report, "E1")?.severity).toBe("ok");
    expect(resultById(ok.report, "E1")?.detail).toContain("@bot:hs.example");
    expect(resultById(ok.report, "E2")?.severity).toBe("ok");

    const rejected = await doctorReport(fakeFetch(() => jsonResponse(401, { errcode: "M_UNKNOWN_TOKEN" })));
    const e1 = resultById(rejected.report, "E1");
    expect(e1?.severity).toBe("fail");
    expect(e1?.summary).toContain("凭据");
    expect(deriveExitCode(rejected.report.results)).toBe(1);

    const down = await doctorReport(fakeFetch(() => "fail"));
    expect(resultById(down.report, "E1")?.severity).toBe("fail");
    expect(resultById(down.report, "E2")?.severity).toBe("fail");
    expect(deriveExitCode(down.report.results)).toBe(1);
  });

  it("永不 resolve → 5 秒超时判 ⏭️ 不判 ❌(fake timers 推进)", { timeout: 60_000 }, async () => {
    writeMatrixConfig();
    // 预热 runDoctor 的动态 import 链(真实定时器下完成抓取):Vite 的模块
    // 抓取管线依赖真实定时器/微任务调度,fake timers 期间冷启动会停摆。
    await import("../src/doctor/checks.js");
    // 限定 toFake:只伪造定时器与 Date(不碰微任务原语)。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pending = doctorReport(fakeFetch(() => "hang"));
    // vi.waitFor 在 fake timers 下每次重试自动推进时钟:A-D 组的真实工作
    // (B 组 which-pi 子进程、pi 包导入)与 E 组 5 秒定时器都在等待窗内完成。
    const { report } = await vi.waitFor(
      async () => {
        const settled = await Promise.race([pending, Promise.resolve(null)]);
        if (settled === null) throw new Error("doctor still running");
        return settled as { report: { results: CheckResult[] } };
      },
      { timeout: 30_000, interval: 100 },
    );
    for (const id of ["E1", "E2"]) {
      const item = resultById(report, id);
      expect(item?.severity, id).toBe("skip");
      expect(item?.summary).toContain("超过 5 秒");
    }
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("未配置 Matrix → E1 ⚠️ 不发请求;无 homeserver → E2 ⏭️(文案不谎称超时)", async () => {
    // 基线配置无 matrix 段
    const fetch = fakeFetch(() => jsonResponse(200, {}));
    const { report } = await doctorReport(fetch);
    expect(resultById(report, "E1")?.severity).toBe("warn");
    const e2 = resultById(report, "E2");
    expect(e2?.severity).toBe("skip");
    // 一个请求都没发:结论是「未配置」,不是「等了 5 秒没响应」;zh 不得出现双前缀
    expect(e2?.summary).toContain("未配置 homeserver");
    expect(e2?.summary).not.toContain("无响应");
    expect(e2?.summary).not.toContain("查不出来");
    expect(fetch.calls).toHaveLength(0); // 没有可查目标就不该发请求
  });

  it("代理配置非法 → E3 ⏭️ 且文案不谎称超时(一个请求都没发)", async () => {
    // socks5 不在 scheme 白名单 → resolveProxySettings 抛错,E3 无法探测
    writeMatrixConfig("socks5://10.0.0.1:1080");
    const fetch = fakeFetch(() => jsonResponse(200, {}));
    const { report } = await doctorReport(fetch);
    const e3 = resultById(report, "E3");
    expect(e3?.severity).toBe("skip");
    expect(e3?.summary).not.toContain("无响应");
    expect(e3?.summary).not.toContain("查不出来");
    // 代理探测本身一个请求都没发(E1/E2 可能各自发,这里只钉 E3 的语义)
    expect(e3?.summary).toContain("无法确认");
  });

  it("代理:未配置 → ✅ 直连;配置并可达 → ✅;不可达 → ❌;超时 → ⏭️", { timeout: 60_000 }, async () => {
    const none = await doctorReport(fakeFetch(() => jsonResponse(200, {})));
    expect(resultById(none.report, "E3")?.severity).toBe("ok");
    expect(resultById(none.report, "E3")?.summary).toContain("直连");

    writeMatrixConfig("http://127.0.0.1:8080");
    const up = await doctorReport(fakeFetch(() => jsonResponse(403, {}))); // 代理回 403 也算可达
    expect(resultById(up.report, "E3")?.severity).toBe("ok");

    const down = await doctorReport(fakeFetch(() => "fail"));
    expect(resultById(down.report, "E3")?.severity).toBe("fail");
    expect(deriveExitCode(down.report.results)).toBe(1);

    await import("../src/doctor/checks.js"); // 预热(同上)
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pending = doctorReport(fakeFetch(() => "hang"));
    const timedOut = await vi.waitFor(
      async () => {
        const settled = await Promise.race([pending, Promise.resolve(null)]);
        if (settled === null) throw new Error("doctor still running");
        return settled as { report: { results: CheckResult[] } };
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(resultById(timedOut.report, "E3")?.severity).toBe("skip");
  });

  it("--offline:fetch 零调用,报告无 E 项,头部带跳过说明", async () => {
    writeMatrixConfig("http://127.0.0.1:8080");
    const fetch = fakeFetch(() => jsonResponse(200, {}));
    const deps = makeHarness({ platform: "linux", homedir: home, env: process.env, fetch });
    const report = await runDoctor(deps, { fix: false, json: false, offline: true });
    expect(fetch.calls).toHaveLength(0);
    expect(report.results.some((r) => r.group === "E")).toBe(false);
    expect(report.offline).toBe(true);
    expect(renderHuman(report)).toContain("--offline");
    expect(deriveExitCode(report.results)).toBe(0);
  });
});

async function doctorReport(fetch: DoctorDeps["fetch"]) {
  const deps = makeHarness({ platform: "linux", homedir: home, env: process.env, fetch });
  const report = await runDoctor(deps, NO_FIX);
  return { report, deps };
}

// ════════════════════════════════════════════════════════════════════════════
// F 组:systemd 服务(只读对比)
// ════════════════════════════════════════════════════════════════════════════

/** unit 文本 fixture(ExecStart 的 node 路径可指定漂移)。 */
function unitText(nodePath: string): string {
  return `# /home/u/.config/systemd/user/pi-courier.service
[Service]
Environment=PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin
ExecStart=${nodePath} /proj/dist/standalone.js
WorkingDirectory=/proj
`;
}

type ExecCall = { file: string; args: string[] };

function fakeExecFile(
  responder: (args: string[]) => { stdout: string; code: number } | "throw",
): { calls: ExecCall[]; execFile: DoctorDeps["execFile"] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    execFile: async (file: string, args: string[]) => {
      calls.push({ file, args });
      const out = responder(args);
      if (out === "throw") throw new Error("systemctl exploded");
      return { stdout: out.stdout, stderr: "", code: out.code };
    },
  };
}

describe("F 组 — systemd 服务只读对比(注入 execFile)", () => {
  it("unit 存在 + enabled + active + node 一致 → F1/F2/F3 ✅", async () => {
    const { execFile, calls } = fakeExecFile((args) => {
      if (args.includes("cat")) return { stdout: unitText(process.execPath), code: 0 };
      if (args.includes("is-enabled")) return { stdout: "enabled", code: 0 };
      if (args.includes("is-active")) return { stdout: "active", code: 0 };
      return { stdout: "", code: 1 };
    });
    const report = await runDoctor(makeHarness({ platform: "linux", homedir: home, env: process.env, execFile }), NO_FIX);
    for (const id of ["F1", "F2", "F3"]) {
      expect(resultById(report, id)?.severity, id).toBe("ok");
    }
    // 只读断言:所有查询都是 systemctl --user cat/is-enabled/is-active
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.file).toBe("systemctl");
      expect(call.args[0]).toBe("--user");
      expect(["cat", "is-enabled", "is-active"].some((ro) => call.args.includes(ro))).toBe(true);
    }
    // 绝不出现写/启停动作
    const joined = calls.map((c) => c.args.join(" ")).join("\n");
    for (const forbidden of ["daemon-reload", "start", "stop", "restart", "enable --now", "disable"]) {
      expect(joined).not.toContain(forbidden);
    }
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("unit 缺失 → F1 ⚠️ + enable 指引;未启用 → F1 ⚠️;inactive → F2 ⚠️", async () => {
    const missing = fakeExecFile((args) => {
      if (args.includes("cat")) return { stdout: "", code: 1 };
      if (args.includes("is-enabled")) return { stdout: "", code: 1 };
      if (args.includes("is-active")) return { stdout: "inactive", code: 3 };
      return { stdout: "", code: 1 };
    });
    const missingReport = await runDoctor(
      makeHarness({ platform: "linux", homedir: home, env: process.env, execFile: missing.execFile }),
      NO_FIX,
    );
    const f1 = resultById(missingReport, "F1");
    expect(f1?.severity).toBe("warn");
    expect(f1?.summary).toContain("未安装");
    expect(f1?.nextStep).toContain("enable");

    const disabled = fakeExecFile((args) => {
      if (args.includes("cat")) return { stdout: unitText(process.execPath), code: 0 };
      if (args.includes("is-enabled")) return { stdout: "", code: 1 };
      if (args.includes("is-active")) return { stdout: "active", code: 0 };
      return { stdout: "", code: 1 };
    });
    const disabledReport = await runDoctor(
      makeHarness({ platform: "linux", homedir: home, env: process.env, execFile: disabled.execFile }),
      NO_FIX,
    );
    expect(resultById(disabledReport, "F1")?.severity).toBe("warn");
    expect(resultById(disabledReport, "F1")?.summary).toContain("未启用");

    const inactive = fakeExecFile((args) => {
      if (args.includes("cat")) return { stdout: unitText(process.execPath), code: 0 };
      if (args.includes("is-enabled")) return { stdout: "enabled", code: 0 };
      if (args.includes("is-active")) return { stdout: "inactive", code: 3 };
      return { stdout: "", code: 1 };
    });
    const inactiveReport = await runDoctor(
      makeHarness({ platform: "linux", homedir: home, env: process.env, execFile: inactive.execFile }),
      NO_FIX,
    );
    const f2 = resultById(inactiveReport, "F2");
    expect(f2?.severity).toBe("warn");
    expect(deriveExitCode(inactiveReport.results)).toBe(0); // ⚠️ 不抬退出码
  });

  it("node 路径漂移 → F3 ⚠️(unit 钉的 node vs process.execPath)", async () => {
    const drifted = fakeExecFile((args) => {
      if (args.includes("cat")) return { stdout: unitText("/usr/bin/node"), code: 0 };
      if (args.includes("is-enabled")) return { stdout: "enabled", code: 0 };
      if (args.includes("is-active")) return { stdout: "active", code: 0 };
      return { stdout: "", code: 1 };
    });
    const report = await runDoctor(
      makeHarness({ platform: "linux", homedir: home, env: process.env, execFile: drifted.execFile }),
      NO_FIX,
    );
    const f3 = resultById(report, "F3");
    expect(f3?.severity).toBe("warn");
    expect(f3?.summary + " " + (f3?.detail ?? "")).toContain("/usr/bin/node");
    expect(f3?.summary + " " + (f3?.detail ?? "")).toContain(process.execPath);
  });

  it("execFile 抛错 → F 组 ⏭️(无法确认),doctor 不崩、退出码按剩余 ❌", async () => {
    const { execFile } = fakeExecFile(() => "throw");
    const report = await runDoctor(
      makeHarness({ platform: "linux", homedir: home, env: process.env, execFile }),
      NO_FIX,
    );
    for (const id of ["F1", "F2", "F3"]) {
      const item = resultById(report, id);
      expect(item?.severity, id).toBe("skip");
      expect(item?.summary).toContain("无法确认");
    }
    expect(deriveExitCode(report.results)).toBe(0);
  });

  it("win32 注入全量跑:F 组 ⏭️ 带原因,其余各组照查不被掩盖", async () => {
    writeMatrixConfig();
    const report = await runDoctor(
      makeHarness({
        platform: "win32",
        homedir: home,
        layout: makeDoctorLayout("linux", home), // POSIX 形布局(config-win32 先例)
        env: process.env,
        fetch: fakeFetch(() => jsonResponse(200, { user_id: "@bot:hs.example" })),
      }),
      NO_FIX,
    );
    for (const id of ["F1", "F2", "F3"]) {
      const item = resultById(report, id);
      expect(item?.severity, id).toBe("skip");
      expect(item?.summary).toContain("Windows");
    }
    // 其余组照查:E 组 ✅(网络通了)、B/C/D/A/G/H 有结果、无 ❌
    expect(resultById(report, "E1")?.severity).toBe("ok");
    expect(deriveExitCode(report.results)).toBe(0);
  });
});
