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
import { effectiveLanguage, loadConfig } from "./config.js";
import { setLocale, t } from "./i18n/index.js";
import { buildLogFilterArgs } from "./log-filter.js";
import { projectLabelOf } from "./project-labels.js";
import { busFailureHint, dirOwnerUid } from "./systemd-hint.js";
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
  console.log(t("cli.usage"));
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

/** Project labels from the config (the single source `log-filter` matches against). */
function projectLabels(): { labels: string[]; multiProject: boolean } {
  const config = loadConfig();
  const projects = config.projects ?? {};
  return { labels: Object.values(projects).map((p) => projectLabelOf(p)), multiProject: config.multiProject === true };
}

function cmdService(action: "start" | "stop" | "restart" | "status" | "logs", args: string[] = []): void {
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
  const cmd = ["systemctl", "--user", action, SERVICE_NAME];
  const { status, stderr } = spawnSystemctlUser(cmd.slice(2));
  if (status !== 0) {
    printBusHint(stderr);
    process.exit(status);
  }
}

function cmdDisable(): void {
  const unitPath = userUnitPath();
  if (!fs.existsSync(unitPath)) {
    console.error(t("cli.disable.notInstalled"));
    process.exit(1);
  }
  // Stop + remove from autostart, then delete the unit file (full uninstall).
  if (systemctlUser(["disable", "--now", SERVICE_NAME]) !== 0) {
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
  const installedViaNpm = !fs.existsSync(path.join(projDir, ".git"));

  // 1. Stop the service first (if running) so the upgrade happens on a clean
  //    state — the old process never touches partially-replaced files.
  const active = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" });
  const wasActive = active.stdout?.trim() === "active";
  if (wasActive) {
    console.log(t("cli.update.stopping"));
    runSystemctl(["stop", SERVICE_NAME]);
  }

  // 2. Upgrade the code.
  if (installedViaNpm) {
    // Installed with `npm install -g pi-courier` → upgrade via npm.
    // --foreground-scripts: postinstall output (e.g. the E2EE native lib
    // download progress from matrix-sdk-crypto-nodejs) streams to the
    // terminal in real time instead of being buffered by npm until the end.
    console.log(t("cli.update.npmUpgrade"));
    const npmArgs = ["install", "-g", "pi-courier@latest", "--foreground-scripts"];
    // The E2EE native lib (21MB from GitHub Releases) is re-downloaded on
    // every npm install because the upstream postinstall uses override:true.
    // When the binary already exists, skip lifecycle scripts — the lib is
    // kept as-is and the update finishes in seconds instead of minutes.
    if (e2eNativeBinaryExists()) {
      console.log(t("cli.update.nativeSkipped"));
      npmArgs.push("--ignore-scripts");
    }
    const res = spawnSync("npm", npmArgs, {
      stdio: "inherit",
    });
    if (res.status !== 0) {
      console.error(t("cli.update.npmFailed", { status: res.status }));
      process.exit(res.status ?? 1);
    }
  } else {
    // Installed from a git clone → pull + install + build.
    console.log(t("cli.update.gitUpgrade"));
    for (const [cmd, args] of [
      ["git", ["pull"]],
      ["npm", ["install"]],
      ["npm", ["run", "build"]],
    ] as const) {
      console.log(`\n$ ${cmd} ${args.join(" ")}`);
      const res = spawnSync(cmd, args, { cwd: projDir, stdio: "inherit" });
      if (res.status !== 0) {
        console.error(t("cli.update.cmdFailed", { cmd, status: res.status }));
        process.exit(res.status ?? 1);
      }
    }
  }

  // 3. Start the service again if it was running, so the update takes effect.
  //    If it wasn't running before the update (manually stopped, or a previous
  //    update was interrupted), tell the user — never silently leave it dead,
  //    and never override an intentional stop.
  if (wasActive) {
    console.log(t("cli.update.restarting"));
    runSystemctl(["start", SERVICE_NAME]);
    console.log(t("cli.update.restarted"));
  } else {
    console.log(t("cli.update.wasInactive"));
    console.log(t("cli.update.startHint"));
  }
  console.log(t("cli.update.done"));
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
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
  console.error("[pi-courier] fatal:", (err as Error).message);
  process.exit(1);
});
