/**
 * 看门狗判定核心(spec #247 票06):三分支(僵死 PID 活 → 先杀后起 /
 * 已死 → 直接重启 / 心跳未过期 → 零动作)、心跳缺失不告警不动作、过期秒
 * 默认 180 可覆盖、POSIX 壳 bash -n 语法门禁。核心全注入(fake 读/判活/
 * 时钟/命令),不碰真实进程与 systemctl。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultPidAlive,
  DEFAULT_STALE_SECONDS,
  fillCommand,
  parseCoreArgs,
  readHeartbeat,
  runWatchdogCore,
} from "../deploy/watchdog/watchdog-core.mjs";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-watchdog-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeHeartbeat(beat: Record<string, unknown>): string {
  const p = path.join(dir, "heartbeat.json");
  fs.writeFileSync(p, JSON.stringify(beat));
  return p;
}

const NOW = 1_700_000_000_000;

function core(overrides: Record<string, unknown> = {}) {
  const run = vi.fn();
  const opts: Record<string, unknown> = {
    staleSeconds: 180,
    nowMs: NOW,
    pidAliveFn: () => false,
    restartCommand: "systemctl --user restart pi-pi-courier",
    runFn: run,
    ...overrides,
  };
  // 默认心跳:旧 200 秒(> 默认过期秒 180,即「已过期」分支的基线);
  // 显式注入 heartbeatPath 时绝不另写文件(同名覆盖会污染注入值)。
  if (!opts.heartbeatPath) {
    opts.heartbeatPath = writeHeartbeat({ ts: NOW - 200_000, pid: 4242 });
  }
  return { run, opts: opts as never };
}

describe("看门狗判定核心三分支(spec #247 票06)", () => {
  it("僵死(心跳过期 + PID 存活)→ 杀旧命令先行、再重启(restart-command + kill-command)", () => {
    const { run, opts } = core({
      pidAliveFn: () => true,
      killCommand: "taskkill /F /PID {pid}",
    });
    const result = runWatchdogCore(opts);

    expect(result.verdict).toBe("stale");
    expect(result.pidAlive).toBe(true);
    expect(result.actions).toEqual(["kill", "restart"]);
    expect(run.mock.calls[0][0]).toBe("taskkill /F /PID 4242");
    expect(run.mock.calls[1][0]).toBe("systemctl --user restart pi-pi-courier");
  });

  it("已死(心跳过期 + PID 不存在)→ 跳过杀,直接重启", () => {
    const { run, opts } = core({
      pidAliveFn: () => false,
      killCommand: "taskkill /F /PID {pid}", // 给了也不用:PID 已死
    });
    const result = runWatchdogCore(opts);

    expect(result.verdict).toBe("dead");
    expect(result.actions).toEqual(["restart"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("systemctl --user restart pi-pi-courier");
  });

  it("心跳未过期且 PID 存活 → 零动作(ok)", () => {
    const { run, opts } = core({
      heartbeatPath: writeHeartbeat({ ts: NOW - 60_000, pid: 4242 }),
      pidAliveFn: () => true,
    });
    const result = runWatchdogCore(opts);

    expect(result.verdict).toBe("ok");
    expect(result.actions).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("心跳仍新鲜但 PID 不存在 → 立即 dead 重启,不等过期窗口(评审)", () => {
    const { run, opts } = core({
      heartbeatPath: writeHeartbeat({ ts: NOW - 1_000, pid: 4242 }),
      pidAliveFn: () => false,
    });
    const result = runWatchdogCore(opts);

    expect(result.verdict).toBe("dead");
    expect(result.actions).toEqual(["restart"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("心跳文件缺失 → missing:不告警、不动作(安装错误,不是进程死亡)", () => {
    const { run, opts } = core({ heartbeatPath: path.join(dir, "absent.json") });
    const result = runWatchdogCore(opts);

    expect(result.verdict).toBe("missing");
    expect(result.actions).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("人工停止标记存在 → paused:不拉起重启、不告警(评审)", () => {
    const marker = path.join(dir, "watchdog-paused");
    fs.writeFileSync(marker, new Date().toISOString());
    const { run, opts } = core({
      heartbeatPath: writeHeartbeat({ ts: NOW - 200_000, pid: 4242 }),
      pidAliveFn: () => true,
      pauseMarkerPath: marker,
      killCommand: "taskkill /F /PID {pid}",
      alertCommand: "node matrix-alert.mjs --message {message}",
    });

    const result = runWatchdogCore(opts);
    expect(result.verdict).toBe("paused");
    expect(result.actions).toEqual([]);
    expect(run).not.toHaveBeenCalled();

    // 标记清除后恢复判定(下次桥启动会清)
    fs.rmSync(marker);
    expect(runWatchdogCore(opts).verdict).toBe("stale");
  });

  it("POSIX 形态(不给 kill-command):僵死也直接 restart(systemctl 天然先 stop 后 start)", () => {
    const { run, opts } = core({
      pidAliveFn: () => true,
      alertCommand: "node matrix-alert.mjs --message {message}",
    });
    const result = runWatchdogCore(opts);

    expect(result.actions).toEqual(["restart", "alert"]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(String(run.mock.calls[1][0])).toContain("STALE (heartbeat frozen, pid alive)");
  });

  it("告警命令失败不阻断(重启已完成,stderr 记录后继续)", () => {
    const run = vi.fn((command: string) => {
      if (command.includes("matrix-alert")) throw new Error("homeserver down");
    });
    const { opts } = core({
      pidAliveFn: () => false,
      alertCommand: "node matrix-alert.mjs --message {message}",
      runFn: run,
    });
    const result = runWatchdogCore(opts);

    expect(result.actions).toEqual(["restart"]); // alert 失败不入列,重启已完成
  });
});

describe("过期秒(spec #247 票06:默认 180 = 6 × 30s 心跳间隔,可覆盖)", () => {
  it("默认常量 180", () => {
    expect(DEFAULT_STALE_SECONDS).toBe(180);
  });

  it("自定义过期秒生效(边界:恰好等于阈值即过期)", () => {
    const { run, opts } = core({
      heartbeatPath: writeHeartbeat({ ts: NOW - 5_000, pid: 1 }),
      staleSeconds: 5,
    });
    expect(runWatchdogCore(opts).verdict).toBe("dead");

    const { opts: fresh } = core({
      heartbeatPath: writeHeartbeat({ ts: NOW - 4_999, pid: 1 }),
      staleSeconds: 5,
      pidAliveFn: () => true,
    });
    expect(runWatchdogCore(fresh).verdict).toBe("ok");
  });
});

describe("CLI 参数解析(parseCoreArgs)", () => {
  it("全参数解析;缺 restart-command 拒绝", () => {
    const opts = parseCoreArgs([
      "--heartbeat",
      "/tmp/hb.json",
      "--stale-seconds",
      "120",
      "--restart-command",
      "systemctl --user restart pi-pi-courier",
      "--alert-command",
      "node alert.mjs --message {message}",
    ]);
    expect(opts?.heartbeatPath).toBe("/tmp/hb.json");
    expect(opts?.staleSeconds).toBe(120);
    expect(opts?.restartCommand).toContain("restart");
    expect(opts?.alertCommand).toContain("alert.mjs");

    expect(parseCoreArgs(["--stale-seconds", "120"])).toBeNull();
  });
});

describe("读心跳与判活默认实现", () => {
  it("readHeartbeat:缺失/坏 JSON/缺字段 → null", () => {
    expect(readHeartbeat(path.join(dir, "nope.json"))).toBeNull();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    expect(readHeartbeat(bad)).toBeNull();
    const empty = writeHeartbeat({ hello: 1 });
    expect(readHeartbeat(empty)).toBeNull();
  });

  it("defaultPidAlive:当前进程活、不可能存在的 PID 死", () => {
    expect(defaultPidAlive(process.pid)).toBe(true);
    // pid 4 理论上可能存在(POSIX 常驻);用一个远超 pid_max 的值
    expect(defaultPidAlive(4_000_000_000)).toBe(false);
  });

  it("fillCommand:pid 与 message 占位替换", () => {
    expect(fillCommand("kill {pid} --say {message}", { pid: 7, message: "hi" })).toBe("kill 7 --say hi");
  });

  it("告警消息含括号也能经真实 execSync 发出(评审:POSIX 壳 alertCommand)", () => {
    if (process.platform === "win32") return;
    const out = path.join(dir, "alert.txt");
    const result = runWatchdogCore({
      heartbeatPath: writeHeartbeat({ ts: NOW - 200_000, pid: 4_000_000_000 }),
      staleSeconds: 180,
      nowMs: NOW,
      pidAliveFn: () => false,
      // 不注入 runFn → 走真实 execSync(/bin/sh -c),复现括号语法错场景
      restartCommand: "true",
      alertCommand: `printf '%s' {message} > ${JSON.stringify(out)}`,
    });

    expect(result.actions).toEqual(["restart", "alert"]);
    expect(fs.readFileSync(out, "utf-8")).toBe("pi-courier watchdog: service was DEAD (pid gone) and has been restarted.");
  });
});

describe("POSIX 壳语法门禁(bash -n,spec #247 票06)", () => {
  it("watchdog-posix.sh 语法合法", () => {
    const script = path.resolve(__dirname, "../deploy/watchdog/watchdog-posix.sh");
    const result = execFileSync("bash", ["-n", script], { encoding: "utf-8" });
    expect(result).toBe("");
  });
});
