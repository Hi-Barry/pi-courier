/**
 * 看门狗 Windows 壳(spec #247 票07):与 POSIX 壳共用 watchdog-core.mjs 的
 * 判定核心,本文件只钉 Windows 平台差异 —— 完整重启序列的次序与脚本契约。
 *
 * 三道门:
 * 1. 命令模板注入测试:从 watchdog-windows.ps1 里取出 $killCommand /
 *    $restartCommand,喂给判定核心,断言「僵死(PID 存活)→ taskkill 先行,
 *    再 end → run」「已死 → 跳过 taskkill,直接 end → run」。
 * 2. 壳端到端(pwsh 可用时):用假 taskkill / schtasks 记录真实调用次序,
 *    验证 PowerShell 参数传递与核心 CLI 拼接没走样。
 * 3. 语法门禁:有 pwsh 时走 PowerShell 自己的 Parser.ParseFile(真解析);
 *    没有时对脚本所用子集做结构校验(字符串/注释/括号配对),Windows 上
 *    必须有真实解析器。
 *
 * 不做真实 taskkill/schtasks 行为验证 —— 那属真机验收(见票评/PR 清单)。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWatchdogCore } from "../deploy/watchdog/watchdog-core.mjs";

const SCRIPT = path.resolve(__dirname, "../deploy/watchdog/watchdog-windows.ps1");
const SHELL = fs.readFileSync(SCRIPT, "utf-8");
const NOW = 1_700_000_000_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-courier-watchdog-win-"));
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

/** 从壳脚本里取顶层 `$name = "字面量"` 赋值(模板不含转义引号),
 *  并按 param 默认值展开 `$TaskName`(PowerShell 在运行时插值)。 */
function psStringVar(name: string): string {
  const match = new RegExp(`^\\$${name}\\s*=\\s*"([^"]*)"`, "m").exec(SHELL);
  if (!match) throw new Error(`watchdog-windows.ps1 缺少 $${name} 赋值`);
  const taskName = /\$TaskName\s*=\s*"([^"]*)"/.exec(SHELL)?.[1] ?? "$TaskName";
  return match[1].replaceAll("$TaskName", taskName);
}

function parseJsonResult(stdout: string): { verdict: string; actions: string[] } {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

function detectPowerShell(): string | null {
  const candidates = [process.env.PWSH, "pwsh", "powershell"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        stdio: "pipe",
        timeout: 15_000,
      });
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return null;
}

const POWERSHELL = detectPowerShell();

describe("Windows 重启序列注入测试(票07:僵死必测)", () => {
  it("僵死(PID 存活)→ taskkill → schtasks /end → /run,次序不可换", () => {
    const run = vi.fn();
    const result = runWatchdogCore({
      heartbeatPath: writeHeartbeat({ ts: NOW - 200_000, pid: 4242 }),
      staleSeconds: 180,
      nowMs: NOW,
      pidAliveFn: () => true,
      killCommand: psStringVar("killCommand"),
      endCommand: psStringVar("endCommand"),
      restartCommand: psStringVar("restartCommand"),
      runFn: run,
    });

    expect(result.verdict).toBe("stale");
    expect(result.actions).toEqual(["kill", "end", "restart"]);
    const calls = run.mock.calls.map((call) => String(call[0]));
    expect(calls).toEqual([
      "taskkill /F /PID 4242",
      "schtasks /end /tn pi-courier",
      "schtasks /run /tn pi-courier",
    ]);
  });

  it("已死(PID 不存在)→ 跳过 taskkill,直接 /end → /run", () => {
    const run = vi.fn();
    const result = runWatchdogCore({
      heartbeatPath: writeHeartbeat({ ts: NOW - 200_000, pid: 4242 }),
      staleSeconds: 180,
      nowMs: NOW,
      pidAliveFn: () => false,
      killCommand: psStringVar("killCommand"),
      endCommand: psStringVar("endCommand"),
      restartCommand: psStringVar("restartCommand"),
      runFn: run,
    });

    expect(result.verdict).toBe("dead");
    expect(result.actions).toEqual(["end", "restart"]);
    const calls = run.mock.calls.map((call) => String(call[0]));
    expect(calls).toEqual(["schtasks /end /tn pi-courier", "schtasks /run /tn pi-courier"]);
  });

  it("end 失败(任务本就没在跑)不阻断 run —— 不能把 end 与 run 串成 &&", () => {
    const calls: string[] = [];
    const run = vi.fn((command: string) => {
      calls.push(String(command));
      if (String(command).includes("schtasks /end")) throw new Error("task is not running");
    });
    const result = runWatchdogCore({
      heartbeatPath: writeHeartbeat({ ts: NOW - 200_000, pid: 4242 }),
      staleSeconds: 180,
      nowMs: NOW,
      pidAliveFn: () => false,
      endCommand: psStringVar("endCommand"),
      restartCommand: psStringVar("restartCommand"),
      runFn: run,
    });

    expect(result.actions).toEqual(["restart"]);
    expect(calls).toEqual(["schtasks /end /tn pi-courier", "schtasks /run /tn pi-courier"]);
  });

  it("模板里 taskkill 只杀心跳 PID,不夹带 end/run;end 与 run 是两条独立命令", () => {
    expect(psStringVar("killCommand")).toBe("taskkill /F /PID {pid}");
    expect(psStringVar("killCommand")).not.toContain("schtasks");
    expect(psStringVar("endCommand")).toBe("schtasks /end /tn pi-courier");
    expect(psStringVar("restartCommand")).toBe("schtasks /run /tn pi-courier");
    expect(psStringVar("restartCommand")).not.toContain("&&");
  });
});

describe("Windows 壳脚本契约(票07:部署产物与安装注释)", () => {
  it("参数默认值与票02/06契约一致:心跳路径、180 秒过期、任务名", () => {
    expect(SHELL).toContain('$HeartbeatPath = "$env:USERPROFILE\\.pi\\pi-courier-state\\heartbeat.json"');
    expect(SHELL).toContain("[int]$StaleSeconds = 180");
    expect(SHELL).toContain('[string]$TaskName = "pi-courier"');
  });

  it("核心参数接线:kill/end/restart 模板透传,告警可关闭且带 {message} 占位", () => {
    expect(SHELL).toContain('"--kill-command", $killCommand');
    expect(SHELL).toContain('"--end-command", $endCommand');
    expect(SHELL).toContain('"--restart-command", $restartCommand');
    expect(SHELL).toContain('--alert-command", "node `"$alert`" --message {message}');
    expect(SHELL).toContain('if (-not $NoAlert)');
  });

  it("文件头安装/卸载注释齐备(任务计划程序每分钟触发,换算关系互指)", () => {
    expect(SHELL).toContain("schtasks /create /tn \"pi-courier-watchdog\"");
    expect(SHELL).toContain("/sc minute /mo 1 /f");
    expect(SHELL).toContain("schtasks /delete /tn \"pi-courier-watchdog\" /f");
    expect(SHELL).toContain("180 = 6 × 30 秒心跳间隔");
    expect(SHELL).toContain("watchdog-core.mjs");
  });
});

describe.skipIf(!POWERSHELL)("Windows 壳端到端(pwsh + 假 taskkill/schtasks)", () => {
  function runShell(heartbeatPath: string): {
    result: { verdict: string; actions: string[] };
    commands: string[];
  } {
    const bin = path.join(dir, "fake-bin");
    const log = path.join(dir, "commands.log");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(log, "");
    for (const name of ["taskkill", "schtasks"]) {
      const p = path.join(bin, name);
      fs.writeFileSync(
        p,
        `#!/bin/sh\nprintf '%s' "${name}" >> "$WATCHDOG_LOG"\nfor a in "$@"; do printf ' %s' "$a" >> "$WATCHDOG_LOG"; done\nprintf '\\n' >> "$WATCHDOG_LOG"\nexit 0\n`,
      );
      fs.chmodSync(p, 0o755);
    }

    const stdout = execFileSync(
      POWERSHELL as string,
      [
        "-NoProfile",
        "-File",
        SCRIPT,
        "-HeartbeatPath",
        heartbeatPath,
        "-StaleSeconds",
        "180",
        "-TaskName",
        "pi-courier",
        "-NoAlert",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          WATCHDOG_LOG: log,
        },
        timeout: 60_000,
      },
    );
    return {
      result: parseJsonResult(stdout),
      commands: fs.readFileSync(log, "utf-8").trim().split(/\r?\n/).filter(Boolean),
    };
  }

  it("僵死:真实调用次序为 taskkill → /end → /run", () => {
    const { result, commands } = runShell(writeHeartbeat({ ts: NOW - 200_000, pid: process.pid }));
    expect(result.verdict).toBe("stale");
    expect(result.actions).toEqual(["kill", "end", "restart"]);
    expect(commands).toEqual([
      `taskkill /F /PID ${process.pid}`,
      "schtasks /end /tn pi-courier",
      "schtasks /run /tn pi-courier",
    ]);
  });

  it("已死:不调 taskkill,只有 /end → /run", () => {
    const { result, commands } = runShell(writeHeartbeat({ ts: NOW - 200_000, pid: 4_000_000_000 }));
    expect(result.verdict).toBe("dead");
    expect(commands).toEqual(["schtasks /end /tn pi-courier", "schtasks /run /tn pi-courier"]);
  });

  it("心跳未过期:零动作", () => {
    const { result, commands } = runShell(writeHeartbeat({ ts: Date.now(), pid: process.pid }));
    expect(result.verdict).toBe("ok");
    expect(commands).toEqual([]);
  });
});

/** PowerShell 子集结构校验:只覆盖本脚本用到的语法(注释、单/双引号、here-string、括号配对)。 */
function structuralErrors(text: string): string[] {
  const errors: string[] = [];
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  const stack: Array<{ ch: string; at: number }> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "<" && text[i + 1] === "#") {
      const end = text.indexOf("#>", i + 2);
      if (end < 0) {
        errors.push("块注释未闭合");
        break;
      }
      i = end + 2;
      continue;
    }
    if (ch === "#") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (ch === "@" && (text[i + 1] === '"' || text[i + 1] === "'")) {
      const terminator = `\n${text[i + 1]}@`;
      const end = text.indexOf(terminator, i + 2);
      if (end < 0) {
        errors.push("here-string 未闭合");
        break;
      }
      i = end + terminator.length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        errors.push("单引号字符串未闭合");
        break;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === "`") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        errors.push("双引号字符串未闭合");
        break;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ ch, at: i });
    } else if (ch === "}" || ch === ")" || ch === "]") {
      const open = stack.pop();
      if (!open || open.ch !== pairs[ch]) {
        errors.push(`括号不配对:${ch}(偏移 ${i})`);
        return errors;
      }
    }
    i++;
  }
  if (stack.length > 0) {
    const last = stack[stack.length - 1];
    errors.push(`括号未闭合:${last.ch}(偏移 ${last.at})`);
  }
  return errors;
}

describe("PowerShell 壳语法门禁(票07)", () => {
  it("watchdog-windows.ps1 语法合法(pwsh 真解析;不可用时结构校验兜底)", () => {
    expect(SHELL).toMatch(/^param\(/m);
    if (POWERSHELL) {
      const script = [
        "$e=$null; $t=$null;",
        `[System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}',[ref]$t,[ref]$e) > $null;`,
        'if ($e.Count -gt 0) { $e | ForEach-Object { $_.ToString() }; exit 1 } else { "PARSE_OK" }',
      ].join(" ");
      const out = execFileSync(POWERSHELL, ["-NoProfile", "-Command", script], {
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(out).toContain("PARSE_OK");
      return;
    }
    // Windows 上 PowerShell 必然存在;非 Windows 开发机允许结构校验兜底
    expect(process.platform === "win32" ? POWERSHELL : "fallback").toBeTruthy();
    expect(structuralErrors(SHELL)).toEqual([]);
  });
});
