import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectSystemLanguage } from "./i18n/detect.js";
import type { Locale } from "./i18n/index.js";
import { adoptManagementRoomPatch } from "./management-room.js";
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

  // Attachment intake (issue #66): root dir + per-file size cap in MB.
  if (process.env.PI_ATTACHMENTS_DIR) {
    config.attachments = {
      ...(config.attachments ?? {}),
      directory: process.env.PI_ATTACHMENTS_DIR,
    };
  }
  if (process.env.PI_ATTACHMENTS_MAX_MB) {
    const mb = Number.parseInt(process.env.PI_ATTACHMENTS_MAX_MB, 10);
    if (Number.isFinite(mb) && mb > 0) {
      config.attachments = { ...(config.attachments ?? {}), maxMb: mb };
    }
  }

  // Log level via env (debug/info/warn/error)
  if (process.env.PI_LOG_LEVEL) {
    config.logLevel = process.env.PI_LOG_LEVEL;
  }

  // pi CLI 路径 via env(与文件配置同字段,env 优先——覆盖链与其余 PI_* 一致)
  if (process.env.PI_CLI_PATH) {
    config.cliPath = process.env.PI_CLI_PATH;
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

/** Runtime read side of the config identity boundary — the rule lives in
 *  identity.ts (spec #72 票5/C6); re-exported here so config 消费方不换导入源。 */
export { nativeMxid } from "./identity.js";

// ── 配置派生函数族(spec #72 票4/C4)────────────────────────────────
// "读出来之后怎么解释"与 ConfigStore 同界:每条默认值只有一处解释,
// setup 向导与运行时消费同一函数,永不漂移。样式沿用 activeSpaceRoomId。

/** 实例名:区分多台部署,默认取主机名。 */
export function effectiveInstanceName(cfg: MsgBridgeConfig): string {
  return cfg.instanceName ?? os.hostname();
}

/** 生效工作目录:未配置时回落到用户 Projects 根目录。 */
export function effectiveWorkdir(cfg: MsgBridgeConfig): string {
  return cfg.workdir ?? defaultProjectsRoot();
}

/** 附件保存根目录(spec #66):默认与 ~/.pi 下其他 pi-courier-* 状态文件平齐。 */
export function attachmentsDirectory(cfg: MsgBridgeConfig): string {
  return cfg.attachments?.directory ?? path.join(os.homedir(), ".pi", "pi-courier-attachments");
}

/** 单个附件上限(MB):默认 10。 */
export function attachmentsMaxMb(cfg: MsgBridgeConfig): number {
  return cfg.attachments?.maxMb ?? 10;
}

/** 单个附件上限(字节),供附件存储直接消费;下限钳制为正。 */
export function attachmentsMaxBytes(cfg: MsgBridgeConfig): number {
  return Math.max(1, attachmentsMaxMb(cfg)) * 1024 * 1024;
}

// ── 语言解析链(issue #83)──────────────────────────────────────────
// PI_LANGUAGE 环境变量 > config "language" > 系统 locale 检测 > "en"。
// env 最高:容器/极简部署里最稳;系统 locale 语义见 i18n/detect.ts。
// source 供启动日志解释"语言从哪来"(非显式配置时打一行 info)。

export type LanguageSource = "env" | "config" | "system" | "default";

export function resolveLanguage(
  cfg: MsgBridgeConfig,
  env: NodeJS.ProcessEnv = process.env
): { locale: Locale; source: LanguageSource } {
  const envLang = env.PI_LANGUAGE?.trim().toLowerCase();
  if (envLang === "zh" || envLang === "en") return { locale: envLang, source: "env" };
  if (cfg.language === "zh" || cfg.language === "en") return { locale: cfg.language, source: "config" };
  const detected = detectSystemLanguage(env);
  if (detected) return { locale: detected, source: "system" };
  return { locale: "en", source: "default" };
}

/** 生效语言(派生函数族:与 effectiveWorkdir 等同模式,单点解释)。 */
export function effectiveLanguage(cfg: MsgBridgeConfig, env: NodeJS.ProcessEnv = process.env): Locale {
  return resolveLanguage(cfg, env).locale;
}

/** Space mode = multi-project deployment with the organizational space
 *  switched on. Single source of truth for the startup ensure, the router's
 *  adoption gate and the /pmctl space hooks. */
export function isSpaceMode(cfg: MsgBridgeConfig): boolean {
  return cfg.multiProject === true && cfg.space?.enabled === true;
}

/** The organizational space this deployment files rooms under, when the
 *  feature is active AND the space has actually been created (degraded runs
 *  with no roomId yet must not attempt space operations). */
export function activeSpaceRoomId(cfg: MsgBridgeConfig): string | undefined {
  return isSpaceMode(cfg) ? cfg.space?.roomId : undefined;
}

/** 管理房间 ID(spec #99 票6 / issue #102):config 以列表存储,但公开语义
 *  是单管理房 —— "取首个"是有意为之。「列表至多一个元素」
 *  的写侧不变量结构化于 management-room.ts 的 adoptManagementRoomPatch
 *  (架构候选4),收养(router)与自建(space ensure)两条写路径经
 *  adoptManagementRoom 委托之。未配置或空列表返回 undefined,即
 *  "还没有管理房";其余所有"管理房是哪个"的读取都走这里,不再手写
 *  `managementRooms?.[0]`。 */
export function managementRoomId(cfg: MsgBridgeConfig): string | undefined {
  return cfg.managementRooms?.[0];
}

/** 离线收件箱策略(issue #113):confirm(默认,征询后执行)/ auto(告知后
 *  直接执行)/ off(与旧版逐字节一致)。手编配置的白名单归一:不认识的值
 *  当 confirm,与"缺省"同形 —— 错字不升级为惊吓行为。 */
export type InboxMode = "confirm" | "auto" | "off";

export function inboxMode(cfg: MsgBridgeConfig): InboxMode {
  const mode = cfg.inbox?.mode;
  return mode === "auto" || mode === "off" ? mode : "confirm";
}

/** 交接卡 /new 联动(issue #122):默认关 —— 自动出卡是一次真实模型调用,
 *  显式 /recap 永远可用。 */
export function recapOnNew(cfg: MsgBridgeConfig): boolean {
  return cfg.recap?.onNew === true;
}

// ── 模型预设与降级链(issues #119 / #121)────────────────────────────
// 语法单一解释:provider/id 引用、思考级别取值、链条目归一,配置校验、
// 预设应用、降级切换三方共用,永不各写一份。

/** pi 的思考级别全集(pi-agent-core ThinkingLevel,2026-10 核对)。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 严格的 `provider/id` 引用解析:斜杠必须有且两侧非空。配置校验与降级链
 *  目标选择用严格版;预设应用与 /model 命令走宽容路径(裸 id 按可用列表解析)。 */
export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** 模型引用列表归一:trim、去空、去重、保持顺序。降级链(全局与项目)
 *  共用 —— 手编配置里的杂散空白和重复条目在这里一次清干净。 */
export function normalizeModelRefList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const ref = item.trim();
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/** 全局降级链(issue #121):缺省/空 = 功能关。项目链覆盖见 ProjectManager
 *  的 projectFallbacks(取值顺序:项目链 > 全局链)。 */
export function modelFallbackChain(cfg: MsgBridgeConfig): string[] {
  return normalizeModelRefList(cfg.modelFallbacks);
}

/** 项目条目的降级链(已归一);undefined = 该项目未覆盖(用全局链)。 */
export function projectFallbackChain(entry: { fallbacks?: string[] } | undefined): string[] | undefined {
  if (!entry?.fallbacks) return undefined;
  return normalizeModelRefList(entry.fallbacks);
}

/** 启动校验(issue #119/#121)的结构化问题:code 供 i18n,值原样携带。 */
export interface PresetProblem {
  /** 配置路径,如 `projects.!roomId:model`、`modelFallbacks[1]` */
  path: string;
  code: "modelRef" | "thinkingLevel" | "fallbacksList";
  /** 原始值(展示用) */
  value?: string;
}

/** 预设/降级链字段的启动校验:只检查新字段,未知字段容忍(向前兼容)。
 *  返回空数组 = 合法。校验是提示不是拦截 —— 坏条目在应用/切换时被跳过,
 *  绝不让一条手编错误挡住进程启动。 */
export function presetProblems(cfg: MsgBridgeConfig): PresetProblem[] {
  const problems: PresetProblem[] = [];
  for (const [roomId, entry] of Object.entries(cfg.projects ?? {})) {
    const model = entry.model?.trim();
    if (model && !parseModelRef(model)) {
      problems.push({ path: `projects.${roomId}:model`, code: "modelRef", value: model });
    }
    const level = entry.thinkingLevel?.trim();
    if (level && !(THINKING_LEVELS as readonly string[]).includes(level)) {
      problems.push({ path: `projects.${roomId}:thinkingLevel`, code: "thinkingLevel", value: level });
    }
    const fallbacks = normalizeModelRefList(entry.fallbacks);
    if (entry.fallbacks !== undefined && !Array.isArray(entry.fallbacks)) {
      problems.push({ path: `projects.${roomId}:fallbacks`, code: "fallbacksList" });
    } else {
      for (const ref of fallbacks) {
        if (!parseModelRef(ref)) {
          problems.push({ path: `projects.${roomId}:fallbacks`, code: "modelRef", value: ref });
        }
      }
    }
  }
  const chain = modelFallbackChain(cfg);
  if (cfg.modelFallbacks !== undefined && !Array.isArray(cfg.modelFallbacks)) {
    problems.push({ path: "modelFallbacks", code: "fallbacksList" });
  } else {
    for (const ref of chain) {
      if (!parseModelRef(ref)) {
        problems.push({ path: "modelFallbacks", code: "modelRef", value: ref });
      }
    }
  }
  return problems;
}

/** 收养写侧(与 managementRoomId 同族):收养第一个成功授权的 DM(router
 *  收养路径)与空间自建管理房(space ensure)共用这一个写入解释 —— 语义
 *  委托 management-room.ts 的 adoptManagementRoomPatch(架构候选4):已有
 *  管理房返回空 patch 拒绝再写,空列表写单元素。幂等:重复收养同一房间
 *  返回空 patch。返回 patch 形状,供 store.update 直接消费,也可展开后与
 *  其它字段合并为一次原子 update。 */
export function adoptManagementRoom(cfg: MsgBridgeConfig, chatId: string): Partial<MsgBridgeConfig> {
  return adoptManagementRoomPatch(cfg.managementRooms, chatId);
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
