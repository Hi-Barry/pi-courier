#!/usr/bin/env node
/**
 * pi-courier 看门狗 —— 判定核心(spec #247 票06)。
 *
 * 零桥代码依赖:只读桥的心跳文件(~/.pi/pi-courier-state/heartbeat.json,
 * 由桥内周期自检 tick 每 30 秒原子写),按需执行注入的「判活 / 任务控制 /
 * 告警」命令。平台壳(POSIX bash / Windows PowerShell)只做参数解析与调用
 * 本核心 —— 判定逻辑只有这一份,两个平台共用。
 *
 * 判定规则:
 *   - 心跳文件读不到(首次运行前):安装错误,不是进程死亡 —— 不告警、
 *     不动作,stderr 记一行即可。
 *   - 心跳时间戳未过期:进程活着且在干活,零动作。
 *   - 心跳过期但 PID 仍存活:僵死(活着不干活)。Windows 序列必须先杀
 *     (单实例锁不抢占,不杀则新实例秒退,看门狗陷入「每分钟拉起→秒退」
 *     死循环);POSIX 的 `systemctl --user restart` 天然先 stop 后 start,
 *     两形态都成立,不需要额外步骤 —— 壳是否传 --kill-command 决定差异。
 *   - 心跳过期且 PID 已不存在:进程死亡,直接重启。
 *
 * 结束任务命令(end-command,可选,Windows 壳专用):在杀旧之后、重启之前
 * 无条件执行一次;失败只记 stderr 不阻断 —— `schtasks /end` 对未运行的
 * 任务会返回非零,而「已死」分支恰恰常见,若把它和 `/run` 串成 `&&`,
 * 重启会被永远跳过。POSIX 壳不传此参数(`systemctl restart` 自己完成 stop)。
 *
 * 「多久算死」的过期秒数单点归属本脚本(桥的韧性配置段刻意不含此键):
 *   默认 180 秒 = 6 × 30 秒心跳间隔。桥侧改 config
 *   resilience.heartbeatIntervalSeconds 时,此处(--stale-seconds 或安装
 *   命令里的参数)同步调整;README 安装步骤与本注释互指。
 *
 * 安装(spec #247,详见 README「看门狗」章节):cron / systemd timer 每分钟
 * 触发本脚本的平台壳;命令与参数见壳文件头注释(与 deploy/pi-courier.user.service
 * 同风格)。
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 心跳过期默认秒数:180 = 6 × 30 秒心跳间隔(换算关系见文件头)。 */
export const DEFAULT_STALE_SECONDS = 180;

/** 默认心跳文件路径(桥的派生状态目录,票02 的写侧契约)。 */
export function defaultHeartbeatPath() {
  return path.join(os.homedir(), ".pi", "pi-courier-state", "heartbeat.json");
}

/** 判活(POSIX/Windows 通用):kill(pid, 0) 只探测不杀。ESRCH=不存在;
 *  EPERM=存在但无权发信号(他人进程)= 活。 */
export function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** 读心跳(票02 写侧契约:{ ts, pid, ... });缺失/坏 JSON/缺关键字段一律
 *  按「读不到」处理(missing —— 安装错误,不告警不动作)。返回 null 或
 *  { ts, pid }。 */
export function readHeartbeat(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  try {
    const beat = JSON.parse(raw);
    if (typeof beat.ts !== "number" || typeof beat.pid !== "number") return null;
    return { ts: beat.ts, pid: beat.pid };
  } catch {
    return null;
  }
}

/** 按宿主 shell 给单个值加引号(告警消息可能含空格/括号)。
 *  POSIX:单引号包裹,内部 ' 转义为 '\'';Windows(cmd.exe):双引号包裹,
 *  内部 " 转义为 \"。平台壳的模板不含引号,由这里统一负责。 */
export function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replaceAll('"', '\\"')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** 命令模板占位符替换:{pid}=心跳 PID,{message}=告警文本(壳传入)。
 *  quoteMessage=true 时 {message} 按宿主 shell 加引号(告警命令专用;
 *  默认英文消息含 `STALE (heartbeat frozen, pid alive)` 这类括号,裸替换
 *  会让 /bin/sh -c 报语法错,告警直接丢失)。 */
export function fillCommand(template, vars, opts = {}) {
  const rawMessage = vars.message ?? "";
  const message = opts.quoteMessage ? shellQuote(rawMessage) : rawMessage;
  return template.replaceAll("{pid}", String(vars.pid)).replaceAll("{message}", message);
}

/**
 * 判定 + 动作执行(壳的薄壳化使然:全部决策在这里,壳只传参)。
 * opts 字段:
 *   heartbeatPath    心跳文件路径
 *   staleSeconds     过期秒(默认 DEFAULT_STALE_SECONDS;壳从命令行透传)
 *   nowMs            时间源(测试注入 fake 时钟)
 *   readHeartbeatFn  读心跳缝(测试注入;默认 readHeartbeat)
 *   pidAliveFn       判活缝(测试注入;默认 defaultPidAlive)
 *   runFn            任务控制命令缝(测试注入 fake;默认 execSync)
 *   killCommand      僵死分支杀旧命令(POSIX 留空;Windows 传 taskkill,票07)
 *   endCommand       结束任务命令(可选;Windows 传 schtasks /end,失败不阻断)
 *   restartCommand   重启命令(必填;{pid} 占位)
 *   alertCommand     告警命令(可选;{message}/{pid} 占位;失败只记 stderr)
 *   alertMessage     告警文本(核心按判定结果拼默认值,英文 —— 公开仓库
 *                    口径,独立部署产物不进桥的 i18n 双表)
 * 返回 { verdict, actions, pid?, pidAlive? }:
 *   verdict: missing=心跳读不到(安装错误);ok=未过期零动作;
 *            stale=僵死(PID 活);dead=已死。
 */
export function runWatchdogCore(opts) {
  const staleSeconds = opts.staleSeconds ?? DEFAULT_STALE_SECONDS;
  const beat = (opts.readHeartbeatFn ?? readHeartbeat)(opts.heartbeatPath);
  if (!beat) {
    process.stderr.write(
      `[watchdog] heartbeat not found at ${opts.heartbeatPath} — first run yet? Nothing to do (installation issue, not a crash).\n`
    );
    return { verdict: "missing", actions: [] };
  }
  const ageMs = (opts.nowMs ?? Date.now()) - beat.ts;
  if (ageMs < staleSeconds * 1000) {
    return { verdict: "ok", actions: [] };
  }

  const alive = (opts.pidAliveFn ?? defaultPidAlive)(beat.pid);
  const verdict = alive ? "stale" : "dead";
  const actions = [];
  const run = opts.runFn ?? ((command) => execSync(command, { stdio: "pipe" }));

  // 僵死且壳给了杀旧命令(Windows):先杀后起 —— 单实例锁对活进程不抢占。
  if (verdict === "stale" && opts.killCommand) {
    run(fillCommand(opts.killCommand, { pid: beat.pid }));
    actions.push("kill");
  }
  // 结束任务实例(Windows):任务可能在进程死后仍卡 Running,不先 end,
  // 随后的 run 会被「禁止同任务并行实例」拒绝。end 对未运行任务返回非零
  // 属预期(已死分支),失败只记 stderr,绝不阻断 run。
  if (opts.endCommand) {
    try {
      run(fillCommand(opts.endCommand, { pid: beat.pid }));
      actions.push("end");
    } catch (err) {
      process.stderr.write(`[watchdog] end command failed (continuing to restart): ${String(err)}\n`);
    }
  }
  run(fillCommand(opts.restartCommand, { pid: beat.pid }));
  actions.push("restart");

  if (opts.alertCommand) {
    const message =
      opts.alertMessage ??
      `pi-courier watchdog: service was ${verdict === "stale" ? "STALE (heartbeat frozen, pid alive)" : "DEAD (pid gone)"} and has been restarted.`;
    try {
      // {message} 必须按宿主 shell 加引号:默认消息含括号/空格,裸替换会
      // 让 /bin/sh -c 语法错,告警在「最需要通知」时静默丢失。
      run(fillCommand(opts.alertCommand, { pid: beat.pid, message }, { quoteMessage: true }));
      actions.push("alert");
    } catch (err) {
      process.stderr.write(`[watchdog] alert command failed (restart already done): ${String(err)}\n`);
    }
  }
  return { verdict, actions, pid: beat.pid, pidAlive: alive };
}

/**
 * CLI 参数解析(壳透传;导出以便测试直测)。
 *   --heartbeat <path>       心跳文件(默认 ~/.pi/pi-courier-state/heartbeat.json)
 *   --stale-seconds <n>      过期秒(默认 180 = 6 × 30s 心跳间隔)
 *   --restart-command <cmd>  重启命令(必填)
 *   --kill-command <cmd>     杀旧命令(可选,Windows 壳专用;{pid} 占位)
 *   --end-command <cmd>      结束任务命令(可选,Windows 壳专用;失败不阻断)
 *   --alert-command <cmd>    告警命令(可选;{message}/{pid} 占位)
 */
export function parseCoreArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--heartbeat":
        result.heartbeatPath = argv[++i];
        break;
      case "--stale-seconds":
        result.staleSeconds = Number.parseInt(argv[++i] ?? "", 10);
        break;
      case "--restart-command":
        result.restartCommand = argv[++i];
        break;
      case "--kill-command":
        result.killCommand = argv[++i];
        break;
      case "--end-command":
        result.endCommand = argv[++i];
        break;
      case "--alert-command":
        result.alertCommand = argv[++i];
        break;
      default:
        process.stderr.write(`[watchdog] unknown argument: ${argv[i]}\n`);
        return null;
    }
  }
  if (!result.restartCommand) {
    process.stderr.write("[watchdog] --restart-command is required\n");
    return null;
  }
  return {
    heartbeatPath: result.heartbeatPath ?? defaultHeartbeatPath(),
    ...(result.staleSeconds !== undefined && Number.isFinite(result.staleSeconds)
      ? { staleSeconds: result.staleSeconds }
      : {}),
    restartCommand: result.restartCommand,
    ...(result.killCommand ? { killCommand: result.killCommand } : {}),
    ...(result.endCommand ? { endCommand: result.endCommand } : {}),
    ...(result.alertCommand ? { alertCommand: result.alertCommand } : {}),
  };
}

// 直接执行:node watchdog-core.mjs --restart-command "..."
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const opts = parseCoreArgs(process.argv.slice(2));
  if (!opts) process.exit(2);
  const result = runWatchdogCore(opts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
