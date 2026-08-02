#!/usr/bin/env node
/**
 * pi-remote CLI — one command for everything.
 *
 *   pi-remote setup    first-run configuration wizard (Matrix account,
 *                      trusted user, workdir; writes ~/.pi/msg-bridge.json)
 *   pi-remote run      run in the foreground (workdir from config, --workdir overrides)
 *   pi-remote enable   install a user-level systemd service (auto-start) and start it
 *   pi-remote start    start the systemd service
 *   pi-remote stop     stop the systemd service
 *   pi-remote status   show service status + recent logs
 *   pi-remote logs     tail the service logs
 *   pi-remote update   update this project (git pull + npm install + build)
 *
 * pi itself is managed independently on the system (npm i -g ...); this
 * project only ever updates itself.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

// Suppress the known `util._extend` deprecation warning emitted by some
// transport dependencies at load time — it pollutes interactive output.
function suppressDeprecationWarnings(): void {
  const orig = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const msg = typeof warning === "string" ? warning : (warning as Error | undefined)?.message ?? "";
    if (msg.includes("util._extend")) return;
    (orig as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}
suppressDeprecationWarnings();

const SERVICE_NAME = "pi-msg-bridge";
const SERVICE_UNIT = `${SERVICE_NAME}.service`;

/** Project root (parent of the dist/ directory this file is compiled into). */
function projectDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function usage(): void {
  console.log(`pi-remote — run the pi coding agent from your messenger

用法:
  pi-remote setup     首次运行配置向导(Matrix 账号、信任用户、工作目录)
  pi-remote run       前台运行(--workdir 可覆盖配置里的工作目录)
  pi-remote enable    安装用户级 systemd 服务并开机自启、立即启动
  pi-remote start      启动服务
  pi-remote stop       停止服务
  pi-remote restart    重启服务
  pi-remote status     查看服务状态与最近日志
  pi-remote logs      跟踪服务日志(Ctrl+C 退出)
  pi-remote disable   卸载服务(停止 + 取消自启 + 删除 unit 文件)
  pi-remote update    更新本项目(git pull + 安装依赖 + 重新构建)

说明:pi 由系统独立安装与升级(npm i -g @earendil-works/pi-coding-agent),
本项目只更新自身。`);
}

// ===========================================================================
// setup
// ===========================================================================

async function cmdSetup(): Promise<void> {
  const { runSetup } = await import("./setup.js");
  await runSetup();
}

// ===========================================================================
// run
// ===========================================================================

async function cmdRun(args: string[]): Promise<void> {
  const config = loadConfig();
  // Only --workdir is supported as a positional override.
  let workdir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workdir") {
      workdir = args[++i];
    } else {
      console.warn(`⚠️  忽略未知参数: ${args[i]}(旧参数已废弃,请用配置或子命令)`);
    }
  }
  const finalWorkdir = workdir ?? config.workdir;
  if (!finalWorkdir) {
    console.error("❌ 未配置工作目录。先运行 `pi-remote setup`,或用 `pi-remote run --workdir <目录>` 指定。");
    process.exit(1);
  }

  const { main } = await import("./standalone.js");
  await main(["--workdir", finalWorkdir]);
}

// ===========================================================================
// enable / start / stop / status / logs
// ===========================================================================

function userUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", SERVICE_UNIT);
}

function buildUnit(projDir: string, workdir: string): string {
  const nodeBin = process.execPath;
  // The pi child process is spawned via PATH ("node" lookup), so the nvm bin
  // dir must come first — otherwise systemd's default PATH finds a system
  // node (e.g. v20) that pi's undici is incompatible with.
  const nodeDir = path.dirname(nodeBin);
  return `[Unit]
Description=pi-remote (messengers -> pi RPC)
After=default.target

[Service]
Type=simple
WorkingDirectory=${projDir}
Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-%h/.config/pi-bridge.env
ExecStart=${nodeBin} ${projDir}/dist/standalone.js --workdir ${workdir}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

function cmdEnable(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 21) {
    console.warn(`⚠️  当前 Node 版本为 v${process.versions.node},pi 的 undici 需要 Node >= 21。建议用 nvm 安装 v24 后重新执行本命令。`);
  }

  const config = loadConfig();
  const projDir = projectDir();
  const workdir = config.workdir ?? process.cwd();

  const unit = buildUnit(projDir, workdir);
  const unitPath = userUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit);
  console.log(`📝 已写入 ${unitPath}`);

  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", "--now", SERVICE_NAME]);
  console.log("✅ 服务已启用并启动(开机自启)。");
  console.log(`   日志: journalctl --user -u ${SERVICE_NAME} -f`);
}

function runSystemctl(args: string[]): void {
  const res = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`❌ systemctl ${args.join(" ")} 失败(退出码 ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

function cmdService(action: "start" | "stop" | "restart" | "status" | "logs"): void {
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error(`❌ 服务未安装。先运行 \`pi-remote enable\` 安装。`);
    process.exit(1);
  }
  const cmd =
    action === "logs"
      ? ["journalctl", "--user", "-u", SERVICE_NAME, "-f"]
      : ["systemctl", "--user", action, SERVICE_NAME];
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (res.status !== 0 && action !== "logs") {
    process.exit(res.status ?? 1);
  }
  if (action === "status") {
    // Append recent logs for convenience
    const logs = spawnSync("journalctl", ["--user", "-u", SERVICE_NAME, "-n", "15", "--no-pager"], {
      encoding: "utf-8",
    });
    if (logs.stdout) console.log(logs.stdout);
  }
}

function cmdDisable(): void {
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error("❌ 服务未安装(unit 文件不存在)。");
    process.exit(1);
  }
  // Stop + remove from autostart, then delete the unit file (full uninstall).
  runSystemctl(["disable", "--now", SERVICE_NAME]);
  fs.rmSync(unitPath, { force: true });
  runSystemctl(["daemon-reload"]);
  console.log("✅ 服务已停止并卸载。以后要恢复:`pi-remote enable`(配置不受影响)。");
}

// ===========================================================================
// update
// ===========================================================================

function cmdUpdate(): void {
  const projDir = projectDir();
  const installedViaNpm = !fs.existsSync(path.join(projDir, ".git"));

  if (installedViaNpm) {
    // Installed with `npm install -g @barryfan2045/pi-remote` → upgrade via npm.
    console.log("🔄 通过 npm 升级 @barryfan2045/pi-remote …");
    const res = spawnSync("npm", ["install", "-g", "@barryfan2045/pi-remote@latest"], {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error(`❌ npm 升级失败(退出码 ${res.status})`);
      process.exit(res.status ?? 1);
    }
  } else {
    // Installed from a git clone → pull + install + build.
    console.log("🔄 更新 pi-remote(git)…");
    for (const [cmd, args] of [
      ["git", ["pull"]],
      ["npm", ["install"]],
      ["npm", ["run", "build"]],
    ] as const) {
      console.log(`\n$ ${cmd} ${args.join(" ")}`);
      const res = spawnSync(cmd, args, { cwd: projDir, stdio: "inherit" });
      if (res.status !== 0) {
        console.error(`❌ ${cmd} 失败(退出码 ${res.status})`);
        process.exit(res.status ?? 1);
      }
    }
  }

  // Restart the service if it's running, so the update takes effect.
  const active = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" });
  if (active.stdout?.trim() === "active") {
    console.log("\n🔄 服务运行中,自动重启…");
    runSystemctl(["restart", SERVICE_NAME]);
  }
  console.log("\n✅ 更新完成。");
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case "status":
    case "logs":
      cmdService(cmd);
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
    default:
      usage();
      if (cmd) console.error(`\n❌ 未知命令: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[pi-remote] fatal:", (err as Error).message);
  process.exit(1);
});
