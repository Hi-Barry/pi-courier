import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MsgBridgeConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "pi-courier.json");

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const config: MsgBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (err) {
      console.error("Failed to load config file:", err);
    }
  }

  // Environment variables override file config (higher priority).
  // Matrix connection requires both PI_MATRIX_HOMESERVER and
  // PI_MATRIX_ACCESS_TOKEN to be set; the other PI_* vars apply individually.
  if (process.env.PI_MATRIX_HOMESERVER && process.env.PI_MATRIX_ACCESS_TOKEN) {
    config.matrix = {
      homeserverUrl: process.env.PI_MATRIX_HOMESERVER,
      accessToken: process.env.PI_MATRIX_ACCESS_TOKEN,
      ...(process.env.PI_MATRIX_ENCRYPTION !== undefined
        ? { encryption: process.env.PI_MATRIX_ENCRYPTION === "true" }
        : {}),
    };
  } else if (process.env.PI_MATRIX_ENCRYPTION !== undefined && config.matrix) {
    config.matrix.encryption = process.env.PI_MATRIX_ENCRYPTION === "true";
  }

  // Trusted users via env: comma-separated MXIDs, e.g.
  // "PI_MATRIX_TRUSTED_USERS=@barry:matrix.purplelin.com,@alice:matrix.purplelin.com"
  if (process.env.PI_MATRIX_TRUSTED_USERS) {
    const users = process.env.PI_MATRIX_TRUSTED_USERS.split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => (u.startsWith("matrix:") ? u : `matrix:${u}`));
    if (users.length > 0) {
      config.auth = {
        ...(config.auth ?? {}),
        trustedUsers: users,
        adminUserId: config.auth?.adminUserId ?? users[0],
      };
    }
  }

  // Working directory via env (container deployments: /root/Projects etc.)
  if (process.env.PI_WORKDIR) {
    config.workdir = process.env.PI_WORKDIR;
  }

  // Log level via env (debug/info/warn/error)
  if (process.env.PI_LOG_LEVEL) {
    config.logLevel = process.env.PI_LOG_LEVEL;
  }

  return config;
}

/**
 * Save config to file with secure permissions.
 */
export function saveConfig(config: MsgBridgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}

/** Default project root (~userHome/Projects) — shared by first-run workdir
 *  resolution and the setup wizard so the fallback cannot drift. */
export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), "Projects");
}

/**
 * Runtime config store — loaded once at startup, injected into every module
 * that needs config. The config file is effectively a database (projects,
 * management rooms, trusted users, channel modes all live in it), and the
 * previous load-modify-save-per-caller pattern could interleave into lost
 * fields. All runtime reads go through `get()` (no disk access) and all
 * runtime writes through `update()` — one in-memory copy, one write path,
 * so single-threaded interleaving can no longer drop a concurrent writer's
 * field. Disk format, path and 0600 permission logic stay in load/saveConfig.
 */
export class ConfigStore {
  private config: MsgBridgeConfig;

  /** `initial` injects a ready-made config (tests); default loads from disk once. */
  constructor(initial?: MsgBridgeConfig) {
    this.config = initial ?? loadConfig();
  }

  /** Current in-memory config. Mutating nested objects directly bypasses the
   *  single write path — always prefer update(). */
  get(): MsgBridgeConfig {
    return this.config;
  }

  /** Shallow-merge a patch into the in-memory config and persist it. */
  update(patch: Partial<MsgBridgeConfig>): void {
    this.config = { ...this.config, ...patch };
    saveConfig(this.config);
  }
}
