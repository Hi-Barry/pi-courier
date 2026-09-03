#!/usr/bin/env node
/**
 * pi-courier CLI — one command for everything.
 *
 *   pi-courier setup    first-run configuration wizard (Matrix account,
 *                      trusted user, workdir; writes ~/.pi/pi-courier.json)
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
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildLogFilterArgs } from "./log-filter.js";
import { projectLabelOf } from "./project-labels.js";
import { suppressKnownWarnings } from "./warnings.js";

suppressKnownWarnings();

const SERVICE_NAME = "pi-courier";
const SERVICE_UNIT = `${SERVICE_NAME}.service`;

/** Read the installed pi-courier version from package.json. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir(), "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Project root (parent of the dist/ directory this file is compiled into). */
function projectDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Whether the E2EE native binary (matrix-sdk-crypto *.node) is already
 * installed in the global node_modules. Used to skip the 21MB re-download
 * during `pi-courier update` (the upstream postinstall always re-downloads
 * with override:true).
 */
function e2eNativeBinaryExists(): boolean {
  const globalNodeModules = path.join(path.dirname(process.execPath), "..", "lib", "node_modules");
  const cryptoPkgDir = path.join(globalNodeModules, "@matrix-org", "matrix-sdk-crypto-nodejs");
  if (!fs.existsSync(cryptoPkgDir)) return false;
  try {
    return fs.readdirSync(cryptoPkgDir).some((f) => f.endsWith(".node"));
  } catch {
    return false;
  }
}

function usage(): void {
  console.log(`pi-courier — run the pi coding agent from your messenger

用法:
  pi-courier setup     首次运行配置向导(Matrix 账号、信任用户、工作目录)
  pi-courier run       前台运行(--workdir 可覆盖配置里的工作目录)
  pi-courier enable    安装用户级 systemd 服务并开机自启、立即启动
  pi-courier start      启动服务
  pi-courier stop       停止服务
  pi-courier restart    重启服务
  pi-courier status     查看服务状态与最近日志(可带项目名过滤)
  pi-courier logs      跟踪服务日志(Ctrl+C 退出);多工程下可加项目名过滤:
                       pi-courier logs <项目> [项目...] [--level debug|info|warn|error]
  pi-courier disable   卸载服务(停止 + 取消自启 + 删除 unit 文件)
  pi-courier update    更新本项目(git pull + 安装依赖 + 重新构建)
  pi-courier -v        显示版本号(--version / version 亦可)

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
  // Supported overrides: --workdir, --level (parsed once by standalone's main).
  const { main } = await import("./standalone.js");
  await main(args);
}

// ===========================================================================
// enable / start / stop / status / logs
// ===========================================================================

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
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 21) {
    console.warn(`⚠️  当前 Node 版本为 v${process.versions.node},pi 的 undici 需要 Node >= 21。建议用 nvm 安装 v24 后重新执行本命令。`);
  }

  // Early read: surfaces config-permission warnings before installing the service.
  loadConfig();
  const projDir = projectDir();

  const unit = buildUnit(projDir);
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

/** Project labels from the config (the single source `log-filter` matches against). */
function projectLabels(): string[] {
  const projects = loadConfig().projects ?? {};
  return Object.values(projects).map((p) => projectLabelOf(p as { name?: string; workdir: string }));
}

function cmdService(action: "start" | "stop" | "restart" | "status" | "logs", args: string[] = []): void {
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error(`❌ 服务未安装。先运行 \`pi-courier enable\` 安装。`);
    process.exit(1);
  }
  if (action === "logs" || action === "status") {
    // status first shows the unit itself (systemctl), then the log window.
    if (action === "status") {
      spawnSync("systemctl", ["--user", "status", SERVICE_NAME], { stdio: "inherit" });
    }
    // Split args: `--level <lvl>` option vs positional project labels.
    let level = "info";
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--level") level = args[++i] ?? "";
      else positional.push(args[i]);
    }
    const filter = buildLogFilterArgs({
      availableLabels: projectLabels(),
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
  const cmd = ["systemctl", "--user", action, SERVICE_NAME];
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
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
  console.log("✅ 服务已停止并卸载。以后要恢复:`pi-courier enable`(配置不受影响)。");
}

// ===========================================================================
// update
// ===========================================================================

function cmdUpdate(): void {
  const projDir = projectDir();
  const installedViaNpm = !fs.existsSync(path.join(projDir, ".git"));

  // 1. Stop the service first (if running) so the upgrade happens on a clean
  //    state — the old process never touches partially-replaced files.
  const active = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" });
  const wasActive = active.stdout?.trim() === "active";
  if (wasActive) {
    console.log("🛑 停止服务…");
    runSystemctl(["stop", SERVICE_NAME]);
  }

  // 2. Upgrade the code.
  if (installedViaNpm) {
    // Installed with `npm install -g pi-courier` → upgrade via npm.
    // --foreground-scripts: postinstall output (e.g. the E2EE native lib
    // download progress from matrix-sdk-crypto-nodejs) streams to the
    // terminal in real time instead of being buffered by npm until the end.
    console.log("🔄 通过 npm 升级 pi-courier …");
    const npmArgs = ["install", "-g", "pi-courier@latest", "--foreground-scripts"];
    // The E2EE native lib (21MB from GitHub Releases) is re-downloaded on
    // every npm install because the upstream postinstall uses override:true.
    // When the binary already exists, skip lifecycle scripts — the lib is
    // kept as-is and the update finishes in seconds instead of minutes.
    if (e2eNativeBinaryExists()) {
      console.log("   (E2EE 原生库已存在,跳过 21MB 下载)");
      npmArgs.push("--ignore-scripts");
    }
    const res = spawnSync("npm", npmArgs, {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error(`❌ npm 升级失败(退出码 ${res.status})`);
      process.exit(res.status ?? 1);
    }
  } else {
    // Installed from a git clone → pull + install + build.
    console.log("🔄 更新 pi-courier(git)…");
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

  // 3. Start the service again if it was running, so the update takes effect.
  //    If it wasn't running before the update (manually stopped, or a previous
  //    update was interrupted), tell the user — never silently leave it dead,
  //    and never override an intentional stop.
  if (wasActive) {
    console.log("🔄 重新启动服务…");
    runSystemctl(["start", SERVICE_NAME]);
    console.log("✅ 服务已重新启动。");
  } else {
    console.log("\nℹ️  更新前服务未运行,已跳过启动。");
    console.log("   如需启动服务: pi-courier start");
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
      if (cmd) console.error(`\n❌ 未知命令: ${cmd}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[pi-courier] fatal:", (err as Error).message);
  process.exit(1);
});
