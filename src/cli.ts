#!/usr/bin/env node
/**
 * pi-courier CLI — one command for everything.
 *
 *   pi-courier setup    first-run configuration wizard (Matrix account,
 *                      trusted user, workdir; writes the bridge config file
 *                      at the layout's configDir/pi-courier.json)
 *   pi-courier run      run in the foreground (workdir from config, --workdir overrides)
 *   pi-courier enable   install a user-level systemd service (auto-start) and start it
 *   pi-courier start    start the systemd service
 *   pi-courier stop     stop the systemd service
 *   pi-courier status   show service status + recent logs (optional project filter)
 *   pi-courier logs     tail the service logs (optional: <project...> [--level])
 *   pi-courier update   update this project (git pull + npm install + build)
 *   pi-courier -v       show the installed version (--version / version)
 *
 * pi itself is managed independently on the system (npm i -g ...); this
 * project only ever updates itself.
 *
 * 升级安全(spec #258 评审修复):main() 在任何配置读取之前先执行旧布局迁移
 * (幂等、单项失败仅警告不中断命令)——否则升级后先跑 `setup` 等子命令会读
 * 空的新配置目录,把存量用户当首跑生成新 device ID,E2EE 连续性即断。迁移
 * 窗口期(旧桥仍在跑、新实例先行搬迁)的新旧实例并行已被 spec 接受:活锁
 * 保留语义内建(绝不偷活锁),/update 流程(先停旧服务再升级)兜底。
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveLanguage, loadConfig, runtimeLayout } from "./config.js";
import { errorMessage } from "./errors.js";
import { setLocale, t } from "./i18n/index.js";
import { buildLegacyMigrationPlan, runLegacyMigration } from "./legacy-migration.js";
import { buildLogFilterArgs } from "./log-filter.js";
import { nativeBindingExists, resolveNpmCli } from "./npm-runtime.js";
import { projectLabelOf } from "./project-labels.js";
import { proxyChildEnv, resolveProxySettings } from "./proxy.js";
import { beginManualStopIntent, type ManualStopIntent } from "./resilience/manual-stop.js";
import { busFailureHint, dirOwnerUid, serviceManagementSupported } from "./systemd-hint.js";
import { buildUpgradePlan, detectInstalledViaNpm, STALL_TIMEOUT_MS, schtasksArgs, UPGRADE_MAX_ATTEMPTS, UPGRADE_TIMEOUT_MS } from "./update/upgrade.js";
import { readBridgeVersion } from "./version.js";
import { suppressKnownWarnings } from "./warnings.js";

suppressKnownWarnings();

const SERVICE_NAME = "pi-courier";
const SERVICE_UNIT = `${SERVICE_NAME}.service`;

// CLI 侧布局(spec #258 票03):手动停意图与被停服务同 stateDir(布局解析
// 单例,与 standalone 组合根同源)。CLI 每命令一进程,模块级解析一次即可。
const LAYOUT = runtimeLayout();

/** Read the installed pi-courier version from package.json. */
function packageVersion(): string {
  return readBridgeVersion() ?? "unknown";
}

/** Project root (parent of the dist/ directory this file is compiled into). */
function projectDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function usage(): void {
  console.log(t("cli.usage"));
}

// ===========================================================================
// setup
// ===========================================================================

async function cmdSetup(): Promise<void> {
  // 代理接线(spec #201 票 #203):向导的登录/whoami fetch 要出网,调度器
  // 必须在进入向导之前装配好。首跑配置多为空,回落认环境变量,与运行时
  // 同一决策函数;校验失败(如 socks5://)在此抛双语错误停下,不进向导。
  const { applyProxySettings } = await import("./proxy.js");
  const settings = applyProxySettings(loadConfig());
  if (settings.source !== "none") {
    console.log(t("proxy.active", { proxy: settings.proxy, source: settings.source, path: LAYOUT.configPath }));
  }
  const { runSetup } = await import("./setup.js");
  await runSetup();
}

// ===========================================================================
// run
// ===========================================================================

async function cmdRun(args: string[]): Promise<void> {
  // Supported overrides: --workdir, --level (parsed once by standalone's main).
  const { main } = await import("./standalone.js");
  await main(args);
}

// ===========================================================================
// enable / start / stop / status / logs
// ===========================================================================

/**
 * Platform guard for the systemd-backed service subcommands (evaluation
 * 2026-10-13): user units + journald only exist on Linux, and `enable` used
 * to write a unit file nothing could ever use before dying on an obscure
 * systemctl error. Refuse up front on every other platform; on Linux this
 * is a no-op and not a single line of the old behavior changes.
 */
function requireLinux(cmd: string): void {
  if (serviceManagementSupported(process.platform)) return;
  console.error(t("cli.service.unsupportedPlatform", { cmd }));
  process.exit(1);
}

function userUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", SERVICE_UNIT);
}

function buildUnit(projDir: string): string {
  const nodeBin = process.execPath;
  // The pi child process is spawned via PATH ("node" lookup), so the nvm bin
  // dir must come first — otherwise systemd's default PATH finds a system
  // node (e.g. v20) that pi's undici is incompatible with.
  const nodeDir = path.dirname(nodeBin);
  // Note: no --workdir here — the service reads the workdir from
  // ~/.pi/pi-courier.json at startup (single source of truth). Editing the
  // config and restarting is enough; `pi-courier enable` does not snapshot it.
  return `[Unit]
Description=pi-courier (messengers -> pi RPC)
After=default.target

[Service]
Type=simple
WorkingDirectory=${projDir}
Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-%h/.config/pi-bridge.env
ExecStart=${nodeBin} ${projDir}/dist/standalone.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function cmdEnable(): void {
  requireLinux("enable");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 21) {
    console.warn(t("cli.enable.nodeTooOld", { version: process.versions.node }));
  }

  // Early read: surfaces config-permission warnings before installing the service.
  loadConfig();
  const projDir = projectDir();

  const unit = buildUnit(projDir);
  const unitPath = userUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit);
  console.log(t("cli.enable.unitWritten", { path: unitPath }));

  // Issue #60: daemon-reload and enable --now are independent steps — failing
  // one must not hide whether the other ran, and the user must never be left
  // guessing whether the service is actually enabled.
  const failed: string[] = [];
  if (systemctlUser(["daemon-reload"]) !== 0) failed.push("daemon-reload");
  if (systemctlUser(["enable", "--now", SERVICE_NAME]) !== 0) failed.push(`enable --now ${SERVICE_NAME}`);
  if (failed.length > 0) {
    console.error(t("cli.enable.failed", { steps: failed.join(", ") }));
    process.exit(1);
  }
  console.log(t("cli.enable.ok"));
  console.log(t("cli.enable.logsHint", { unit: SERVICE_NAME }));
}

/** Issue #59: append the targeted `su`-trap hint when a systemctl failure
 *  looks like the bus-owner mismatch (XDG_RUNTIME_DIR inherited from another
 *  user via `su` without `-`). No-op for every other failure. */
function printBusHint(stderr?: string): void {
  const hint = busFailureHint({
    euid: typeof process.getuid === "function" ? process.getuid() : -1,
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    xdgOwnerUid: dirOwnerUid(process.env.XDG_RUNTIME_DIR),
    stderr,
  });
  if (hint) console.error(hint);
}

/** Spawn `systemctl --user ...` with stderr captured (but still echoed).
 *  Shared by every caller so the su-trap hint always has stderr to inspect. */
function spawnSystemctlUser(args: string[]): { status: number; stderr: string } {
  const res = spawnSync("systemctl", ["--user", ...args], { stdio: ["inherit", "inherit", "pipe"] });
  const stderr = res.stderr?.toString() ?? "";
  if (stderr) process.stderr.write(stderr);
  return { status: res.status ?? 1, stderr };
}

/** Run `systemctl --user ...`, appending the targeted su-trap hint on
 *  failure (issue #59). Returns the exit code (0 = ok). */
function systemctlUser(args: string[]): number {
  const { status, stderr } = spawnSystemctlUser(args);
  if (status !== 0) {
    console.error(t("cli.systemctl.failed", { args: args.join(" "), status }));
    printBusHint(stderr);
  }
  return status;
}

/** systemctlUser + exit-on-failure — the historical runSystemctl contract. */
function runSystemctl(args: string[]): void {
  const code = systemctlUser(args);
  if (code !== 0) process.exit(code);
}

/**
 * 人工停止标记(spec #247 评审):stop/disable/update 必须在调 systemctl 之前
 * 由 CLI 自己落盘 —— 被停进程僵死时 Node 信号处理器根本跑不到,标记永远写不
 * 出来,看门狗下一轮会把服务重新拉起。CLI 与被停进程同用户、同 stateDir。
 * 写失败只告警不阻断停止;调用方在 systemctl 结果确认后 settle 回滚/保留。
 */
function beginServiceStop(): ManualStopIntent {
  const intent = beginManualStopIntent(LAYOUT.stateDir);
  if (!intent.written) {
    console.error(t("cli.service.stopMarkerFailed", { path: intent.markerPath }));
  }
  return intent;
}

/**
 * 停服务并处理人工停止标记(第3轮评审):
 *  - systemctl 之前先写标记(进程僵死也能落盘);
 *  - CLI 在等待期间被 Ctrl+C/SIGTERM 中断时无法确认服务已停,回滚标记,
 *    避免看门狗对一个仍在跑的服务失明;
 *  - 正常返回后按退出码 settle(0=确认停止、保留标记;非0=回滚)。
 * spawnSync 阻塞事件循环,信号会排队到返回之后:先执行 confirmed/settle,
 * 再派发 handler,所以 handler 用 confirmed 判断不会误回滚已确认的停止。
 */
function runServiceStop(args: string[]): number {
  const intent = beginServiceStop();
  let confirmed = false;
  const onSignal = (code: number): void => {
    intent.settle(confirmed);
    process.exit(code);
  };
  process.once("SIGINT", () => onSignal(130));
  process.once("SIGTERM", () => onSignal(143));
  const status = systemctlUser(args);
  confirmed = true;
  intent.settle(status === 0);
  return status;
}

/** Project labels from the config (the single source `log-filter` matches against). */
function projectLabels(): { labels: string[]; multiProject: boolean } {
  const config = loadConfig();
  const projects = config.projects ?? {};
  return { labels: Object.values(projects).map((p) => projectLabelOf(p)), multiProject: config.multiProject === true };
}

function cmdService(action: "start" | "stop" | "restart" | "status" | "logs", args: string[] = []): void {
  requireLinux(action);
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error(t("cli.service.notInstalled"));
    process.exit(1);
  }
  if (action === "logs" || action === "status") {
    // status first shows the unit itself (systemctl), then the log window.
    if (action === "status") {
      const st = spawnSystemctlUser(["status", SERVICE_NAME]);
      if (st.status !== 0) {
        // Issue #61: the journal window below shows HISTORY — without this
        // line a dead service's old logs read like "the service is running".
        console.error(t("cli.service.statusFailed", { status: st.status }));
        printBusHint(st.stderr);
      }
    }
    // Split args: `--level <lvl>` option vs positional project labels.
    let level = "info";
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--level") level = args[++i] ?? "";
      else positional.push(args[i]);
    }
    const { labels, multiProject } = projectLabels();
    // Single-project mode tags nothing, so a project filter can never match —
    // say so instead of silently presenting an empty view (spec #34).
    if (positional.length > 0 && !multiProject) {
      console.error(t("cli.service.singleProjectNoFilter"));
      process.exit(1);
    }
    const filter = buildLogFilterArgs({
      unit: SERVICE_NAME,
      availableLabels: labels,
      requestedProjects: positional,
      level,
      follow: action === "logs",
      lineCount: action === "status" ? 15 : undefined,
    });
    if (!filter.ok) {
      console.error(`❌ ${filter.message}`);
      process.exit(1);
    }
    const journalArgs = action === "status" ? ["--no-pager", ...filter.args] : filter.args;
    const res = spawnSync("journalctl", journalArgs, { stdio: "inherit" });
    // logs runs in follow mode: Ctrl+C can surface a non-zero exit — ignore it
    // (same tolerance as before); status's window exit is meaningful.
    if (res.status !== 0 && action === "status") {
      process.exit(res.status ?? 1);
    }
    return;
  }
  // spawnSystemctlUser 自带 systemctl --user 前缀,这里只传其余参数
  // stop 先写人工停止标记:进程僵死时信号处理器跑不到,只能由 CLI 落盘。
  // restart 不写:它紧接着会启动新实例,新实例启动即清标记。
  if (action === "stop") {
    const status = runServiceStop(["stop", SERVICE_NAME]);
    if (status !== 0) process.exit(status);
    return;
  }
  const { status, stderr } = spawnSystemctlUser([action, SERVICE_NAME]);
  if (status !== 0) {
    printBusHint(stderr);
    process.exit(status);
  }
}

function cmdDisable(): void {
  requireLinux("disable");
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error(t("cli.disable.notInstalled"));
    process.exit(1);
  }
  // Stop + remove from autostart, then delete the unit file (full uninstall).
  // 与 stop 同款:先由 CLI 写人工停止标记,进程僵死也能落盘;中断回滚同源。
  if (runServiceStop(["disable", "--now", SERVICE_NAME]) !== 0) {
    // Issue #60: the failure path must not delete the unit — say so explicitly.
    console.error(t("cli.disable.keptUnit"));
    process.exit(1);
  }
  fs.rmSync(unitPath, { force: true });
  runSystemctl(["daemon-reload"]);
  console.log(t("cli.disable.ok"));
}

// ===========================================================================
// update
// ===========================================================================

function cmdUpdate(): void {
  const projDir = projectDir();
  const installedViaNpm = detectInstalledViaNpm(projDir);

  // 代理配置先解析/校验,再停服务(spec #320):配置非法(socks5 等)时
  // 直接报双语错误退出,不把正在跑的服务停在半路。
  const proxySettings = resolveProxySettings(loadConfig());
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(proxyChildEnv(proxySettings) ?? {}),
  };

  // 1. Stop the service first (if running) so the upgrade happens on a clean
  //    state — the old process never touches partially-replaced files.
  //    Linux-only: there is no systemctl elsewhere, and the upgrade itself
  //    works fine without it — skip the stop/start choreography with a note
  //    instead of failing the whole update (evaluation 2026-10-13).
  let wasActive = false;
  if (serviceManagementSupported(process.platform)) {
    const active = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" });
    wasActive = active.stdout?.trim() === "active";
    if (wasActive) {
      console.log(t("cli.update.stopping"));
      // 升级的 stop 同样先由 CLI 写人工停止标记:进程僵死时 handler 跑不到,
      // 否则升级的 npm/git 替换文件期间看门狗可能把旧版本拉起来。
      const stopStatus = runServiceStop(["stop", SERVICE_NAME]);
      if (stopStatus !== 0) process.exit(stopStatus);
    }
  } else {
    console.log(t("cli.update.serviceSkipped"));
  }

  // 2. Upgrade the code(spec #320):与桥内 /update 共用同一套步骤 ——
  // 固定 install --ignore-scripts → ensure → 校验 .node。CLI 是同步执行,
  // 不涉及 stdout 管道死锁;超时/进程树杀是尽力而为(用户在场可 Ctrl+C)。
  if (installedViaNpm) console.log(t("cli.update.npmUpgrade"));
  else console.log(t("cli.update.gitUpgrade"));

  const steps = buildUpgradePlan({
    projectDir: projDir,
    nodeExecPath: process.execPath,
    npmCli: resolveNpmCli(process.execPath),
    installedViaNpm,
  });
  // Windows 看门狗暂停(#326 票 #329):看门狗的动作脚本恰在包目录内,升级
  // 重装替换包目录的瞬间触发会报「无法找到脚本文件」;第一步前暂停、finally
  // 恢复(best-effort,任务不存在/权限不足只警告)。process.exit 不走
  // finally —— 失败退出码先收集,恢复后再统一退出。
  let exitCode: number | undefined;
  const schtasksChange = (action: "disable" | "enable"): void => {
    const args = schtasksArgs(process.platform, action);
    if (!args) return;
    const res = spawnSync("schtasks", args, { stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
    if (res.status !== 0) console.warn(t("cli.update.watchdogSkip", { action }));
  };
  try {
    schtasksChange("disable");
    for (const [stepOffset, step] of steps.entries()) {
      console.log(`\n$ ${step.cmd} ${step.args.join(" ")}`);
      // CLI 是同步执行(stdio inherit),读不到子进程输出流,挂不了桥内的
      // 「无进展看门狗」;对齐两条路径的重试节奏(spec #326 story 9):可重试
      // 步骤以 STALL_TIMEOUT_MS(10 分钟,= 桥的 stall 阈值)为单次尝试上限,
      // 3 次共 30 分钟 = 桥的绝对上限;慢而未死的安装靠 npm 缓存在重试间推进。
      // 真实 spawn 错误(ENOENT 等)不是超时,不重试 —— 超时判定用「被我们的
      // killSignal(SIGKILL) 杀掉」这一确定性事实,不用 error.code(不同 Node
      // 版本对超时错误的 code 约定不一致,ENOENT 同样 error!=null)。
      const attempts = step.retriable === true ? UPGRADE_MAX_ATTEMPTS : 1;
      const attemptTimeoutMs =
        step.retriable === true ? STALL_TIMEOUT_MS : (step.timeoutMs ?? UPGRADE_TIMEOUT_MS);
      let res: ReturnType<typeof spawnSync> | undefined;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (attempt > 1) {
          console.warn(t("cmd.update.progress.retry", { attempt, max: attempts }));
        }
        res = spawnSync(step.cmd, step.args, {
          cwd: step.cwd,
          stdio: "inherit",
          env: childEnv,
          timeout: attemptTimeoutMs,
          killSignal: "SIGKILL",
        });
        const timedOut = res.status === null && res.signal === "SIGKILL";
        if (!timedOut || attempt === attempts) break;
      }
      if (!res || res.error || res.status !== 0) {
        const status = res?.status ?? res?.error?.message ?? "unknown";
        console.error(
          t("cli.update.cmdFailed", {
            cmd: `${step.cmd} ${step.args.join(" ")}`,
            status,
          }),
        );
        exitCode = res?.status ?? 1;
        break;
      }
      // 步完成里程碑(spec #326 票 #328 评审整改):与房间回执同键,CLI 不缺席。
      console.log(t("cmd.update.progress.done", { index: stepOffset + 1, total: steps.length }));
    }
    if (exitCode === undefined && !nativeBindingExists(projDir)) {
      console.error(t("cli.update.nativeMissing"));
      exitCode = 1;
    }
  } finally {
    schtasksChange("enable");
  }
  if (exitCode !== undefined) process.exit(exitCode);

  // 3. Start the service again if it was running, so the update takes effect.
  //    If it wasn't running before the update (manually stopped, or a previous
  //    update was interrupted), tell the user — never silently leave it dead,
  //    and never override an intentional stop. Linux-only, as above.
  if (serviceManagementSupported(process.platform)) {
    if (wasActive) {
      console.log(t("cli.update.restarting"));
      runSystemctl(["start", SERVICE_NAME]);
      console.log(t("cli.update.restarted"));
    } else {
      console.log(t("cli.update.wasInactive"));
      console.log(t("cli.update.startHint"));
    }
  }
  console.log(t("cli.update.done"));
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  // ---- 旧布局迁移(spec #258 评审修复):必须先于任何配置读取 -----------------
  // CLI 每命令一进程,模块级 LAYOUT(runtimeLayout())只是纯路径派生,不含
  // 配置读取;本进程首个真正的配置读取是下方语言解析的 loadConfig()。迁移
  // 压在它之前:存量 ~/.pi 下的配置/存储先搬进新家,`setup` 才能看到「已有
  // token」走保留分支(否则读空的新配置当首跑,生成新 device ID,E2EE 连续
  // 性断裂)。迁移幂等、逐项失败只警告不抛(runLegacyMigration 内建),绝不
  // 中断任何子命令;迁移日志此时还是默认语言(语言要读配置,配置要等迁移
  // 搬家,与 standalone 同款已知取舍)。`run` 子命令随后会在 standalone 组合
  // 根再过一遍迁移 —— 幂等主通道(旧不在即跳过)零日志,无副作用。
  runLegacyMigration({
    plan: buildLegacyMigrationPlan({ platform: process.platform, homedir: os.homedir(), layout: LAYOUT }),
  });

  const [cmd, ...rest] = process.argv.slice(2);
  // Language wiring (issue #83): every subcommand except `setup` localizes
  // from the full chain (PI_LANGUAGE > config > system locale > en). `setup`
  // asks the language itself as its first question.
  if (cmd !== "setup") {
    setLocale(effectiveLanguage(loadConfig()));
  }
  switch (cmd) {
    case "setup":
      await cmdSetup();
      break;
    case "run":
      await cmdRun(rest);
      break;
    case "enable":
      cmdEnable();
      break;
    case "start":
    case "stop":
    case "restart":
      cmdService(cmd);
      break;
    case "status":
    case "logs":
      cmdService(cmd, rest);
      break;
    case "disable":
      cmdDisable();
      break;
    case "update":
      cmdUpdate();
      break;
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(packageVersion());
      break;
    default:
      usage();
      if (cmd) console.error(t("cli.unknownCommand", { cmd }));
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[pi-courier] fatal:", errorMessage(err));
  process.exit(1);
});
