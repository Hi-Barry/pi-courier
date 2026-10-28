import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultWindowsLocale, detectSystemLanguage } from "./i18n/detect.js";
import type { Locale } from "./i18n/index.js";
import { nextManagementRooms } from "./management-room.js";
import type { MsgBridgeConfig, ProjectConfig, SpaceConfig } from "./types.js";

/** 桥的配置目录 ~/.pi(单一持有:Matrix 客户端存储路径等从这里取 —— 审计工程批 票19)。 */
export const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "pi-courier.json");

/** Nested map fields whose entries are dereferenced downstream — a hand-edited
 *  `null`/scalar entry used to crash loading with a TypeError (audit stability
 *  batch 票15). Non-object entries are dropped with a warning; the
 *  "never block startup" contract holds under any disk content. */
const NESTED_MAP_FIELDS = ["projects"] as const;

/** Drop malformed entries from nested map fields; keeps everything else
 *  untouched. Returns the sanitized object (or {} when the file isn't one). */
function sanitizeFileConfig(fileConfig: unknown): Record<string, unknown> {
  if (typeof fileConfig !== "object" || fileConfig === null || Array.isArray(fileConfig)) {
    if (fileConfig !== undefined) {
      console.warn("⚠️  Config file root is not an object — ignoring file content.");
    }
    return {};
  }
  const source = fileConfig as Record<string, unknown>;
  for (const field of NESTED_MAP_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      console.warn(`⚠️  Config field "${field}" is not a map — dropping it.`);
      delete source[field];
      continue;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        console.warn(`⚠️  Config "${field}.${key}" is not an object — dropping the entry.`);
        delete (value as Record<string, unknown>)[key];
      }
    }
  }
  return source;
}

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const config: MsgBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      // Permission self-check is POSIX-only (evaluation 2026-10-13): libuv
      // reports only 0666/0444 for regular files on Windows, so the 0600
      // contract has no meaning there and the check would warn on every
      // single start. The 0600/0700 writes below stay — on Windows libuv
      // maps them to "writable", which is harmless.
      if (process.platform !== "win32") {
        const stats = fs.statSync(CONFIG_PATH);
        const mode = stats.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
        }
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      Object.assign(config, sanitizeFileConfig(fileConfig));
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
  // mode only applies when the file is CREATED — a pre-existing file (e.g.
  // written loose by an older version) keeps whatever it had. Enforce the
  // documented 0600/0700 contract explicitly.
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set config file permissions:", err);
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
  return cfg.attachments?.directory ?? path.join(CONFIG_DIR, "pi-courier-attachments");
}

/** 单个附件上限(MB):默认 10。 */
export function attachmentsMaxMb(cfg: MsgBridgeConfig): number {
  return cfg.attachments?.maxMb ?? 10;
}

/** 单个附件上限(字节),供附件存储直接消费;下限钳制为正。 */
export function attachmentsMaxBytes(cfg: MsgBridgeConfig): number {
  return Math.max(1, attachmentsMaxMb(cfg)) * 1024 * 1024;
}

/** bash 回帖截断上限默认值(字符)。 */
export const BASH_OUTPUT_LIMIT_DEFAULT = 30000;
/** bash 回帖截断上限硬顶(64KB):Matrix 单事件大小上限 —— 配置超过它,
 *  回帖必然被 homeserver 拒,钳到这里就是"配置再多也不越过服务器红线"。 */
export const BASH_OUTPUT_LIMIT_MAX = 64 * 1024;

/** bash 回帖输出截断上限(字符;`!`/`!!`//`/bash` 共用):缺省/非法值回落
 *  默认,超过 64KB 硬顶钳制。与 inboxMode 同风格的手编白名单归一。 */
export function bashOutputLimit(cfg: MsgBridgeConfig): number {
  const value = cfg.bashOutputLimit;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return BASH_OUTPUT_LIMIT_DEFAULT;
  }
  return Math.min(Math.floor(value), BASH_OUTPUT_LIMIT_MAX);
}

/** 工具调用参数展示上限默认值(字符,每个参数值独立计算)。 */
export const TOOL_CALL_ARG_LIMIT_DEFAULT = 100;
/** 工具调用参数展示上限硬顶(字符):活卡按 4000 字符滚动分片,500 约占
 *  一张卡的八分之一 —— 再长单个参数会淹没整张卡的工具时间线。 */
export const TOOL_CALL_ARG_LIMIT_MAX = 500;

/** 工具调用参数展示上限(字符;逐条回复与聚合活卡共用):缺省/非法值回落
 *  默认,超过硬顶按硬顶使用(超限配置直接忽略)。不足 1 的小数经 floor 会
 *  成 0(truncate 只剩省略号),按非法值回落默认 —— 与 bashTimeoutMinutes
 *  的亚分钟守卫同口径。 */
export function toolCallArgLimit(cfg: MsgBridgeConfig): number {
  const value = cfg.toolCallArgLimit;
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return TOOL_CALL_ARG_LIMIT_DEFAULT;
  }
  return Math.min(Math.floor(value), TOOL_CALL_ARG_LIMIT_MAX);
}

/** bash 执行等待上限默认值(分钟,spec #218 票 #220)。 */
export const BASH_TIMEOUT_MINUTES_DEFAULT = 10;

/** bash 执行等待上限(分钟;`!`/`!!`//`/bash` 共用):缺省/非法值/亚分钟
 *  手编(<1,floor 后会成 0ms 立即假超时)一律回落默认。与 bashOutputLimit
 *  同风格的手编白名单归一;不设硬顶 —— 超长任务是配置存在的意义。 */
export function bashTimeoutMinutes(cfg: MsgBridgeConfig): number {
  const value = cfg.bashTimeoutMinutes;
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return BASH_TIMEOUT_MINUTES_DEFAULT;
  }
  return Math.floor(value);
}

// ── 进程韧性派生(spec #247)────────────────────────────────────────
// 韧性配置段(cfg.resilience)的解释单点:每条默认值只有这里一处,后续票
// (04 水位阈值、05 拉起上限)追加键时沿用同款手编白名单归一。

/** 心跳间隔默认值(秒,spec #247 票02):看门狗过期秒的换算基线(默认
 *  180 秒 = 6 × 30;换算关系单点归属看门狗脚本,文档与脚本注释互指)。 */
export const HEARTBEAT_INTERVAL_SECONDS_DEFAULT = 30;

/** 心跳写入间隔(秒):桥内周期自检 tick 的节拍。缺省/非法值(非正数、
 *  非有限数)回落默认,floor 到整秒 —— 与 bashTimeoutMinutes 同款手编
 *  白名单归一。 */
export function heartbeatIntervalSeconds(cfg: MsgBridgeConfig): number {
  const value = cfg.resilience?.heartbeatIntervalSeconds;
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return HEARTBEAT_INTERVAL_SECONDS_DEFAULT;
  }
  return Math.floor(value);
}

/** 磁盘软阈值默认(MB,spec #247 票04):跌破告警一次,回升发恢复。 */
export const DISK_SOFT_MB_DEFAULT = 2048;
/** 磁盘硬阈值默认(MB,spec #247 票04):低于即退(启动期只日志,运行期
 *  留言 + 优雅退出)。 */
export const DISK_HARD_MB_DEFAULT = 512;
/** 堆告警默认百分比(spec #247 票04)。 */
export const HEAP_ALERT_PERCENT_DEFAULT = 80;

/** 白名单归一一条可选数值配置:非有限数/非正数回落默认(整型)。 */
function positiveIntOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/** 磁盘硬阈值(MB):缺省/非法值回落默认。 */
export function diskHardMb(cfg: MsgBridgeConfig): number {
  return positiveIntOrDefault(cfg.resilience?.diskHardMb, DISK_HARD_MB_DEFAULT);
}

/** 磁盘软阈值(MB):缺省/非法值回落默认;恒钳在硬阈值之上(不变式
 *  软 > 硬,手编倒挂时按硬阈值 +1 —— 否则软告警永远没机会先于硬退发出)。 */
export function diskSoftMb(cfg: MsgBridgeConfig): number {
  const raw = positiveIntOrDefault(cfg.resilience?.diskSoftMb, DISK_SOFT_MB_DEFAULT);
  return Math.max(raw, diskHardMb(cfg) + 1);
}

/** 堆告警百分比:缺省/非法值回落默认,钳制到 [1, 100]。 */
export function heapAlertPercent(cfg: MsgBridgeConfig): number {
  const value = cfg.resilience?.heapAlertPercent;
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return HEAP_ALERT_PERCENT_DEFAULT;
  }
  return Math.min(Math.floor(value), 100);
}

/** pi RPC 自动拉起上限默认(次,spec #247 票05)。 */
export const RPC_RESPAWN_LIMIT_DEFAULT = 5;

/** pi RPC 自动拉起上限(连续意外崩溃次数):缺省/非法值回落默认。 */
export function rpcRespawnLimit(cfg: MsgBridgeConfig): number {
  return positiveIntOrDefault(cfg.resilience?.rpcRespawnLimit, RPC_RESPAWN_LIMIT_DEFAULT);
}

// ── 自定义头像路径派生(spec #84 v5 用户覆盖)────────────────────────
// 空间/bot/项目三个消费位共用一条归一规则:~ 展开、相对 ~/.pi/ 解析、
// 扩展名白名单定 mimetype。派生只有这一处解释,自愈与 /pmctl 同源。

/** 自定义头像支持的扩展名 → mimetype;白名单外一律视为配置无效。 */
const CUSTOM_AVATAR_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 归一一条自定义头像路径:空白串视为未配置;前缀 ~ 展开到用户主目录;
 *  相对路径相对 ~/.pi/(CONFIG_DIR)解析。返回值恒为绝对路径或 undefined。 */
export function customAvatarPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const expanded = trimmed.startsWith("~") ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  return path.isAbsolute(expanded) ? expanded : path.join(CONFIG_DIR, expanded);
}

/** 自定义头像的 mimetype(按扩展名,大小写不敏感);白名单外返回 undefined。 */
export function customAvatarMime(filePath: string): string | undefined {
  return CUSTOM_AVATAR_MIME[path.extname(filePath).toLowerCase()];
}

/** 空间自定义头像路径;undefined = 本启动视作未配置(走内置图池)。 */
export function spaceAvatarPath(cfg: MsgBridgeConfig): string | undefined {
  return customAvatarPath(cfg.spaceAvatar);
}

/** bot profile 自定义头像路径;undefined = 走内置 agent 图池。 */
export function botAvatarPath(cfg: MsgBridgeConfig): string | undefined {
  return customAvatarPath(cfg.botAvatar);
}

/** 项目房间自定义头像路径;undefined = 走内置 room 图池。 */
export function projectAvatarPath(project: ProjectConfig | undefined): string | undefined {
  return customAvatarPath(project?.avatar);
}

// ── 语言解析链(issue #83)──────────────────────────────────────────
// PI_LANGUAGE 环境变量 > config "language" > 系统 locale 检测 > "en"。
// env 最高:容器/极简部署里最稳;系统 locale 语义见 i18n/detect.ts
// (POSIX 变量链 + win32 的 ICU 回退,issue #189)。
// source 供启动日志解释"语言从哪来"(非显式配置时打一行 info)。

export type LanguageSource = "env" | "config" | "system" | "default";

export function resolveLanguage(
  cfg: MsgBridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  windowsLocale: () => string | undefined = defaultWindowsLocale
): { locale: Locale; source: LanguageSource } {
  const envLang = env.PI_LANGUAGE?.trim().toLowerCase();
  if (envLang === "zh" || envLang === "en") return { locale: envLang, source: "env" };
  if (cfg.language === "zh" || cfg.language === "en") return { locale: cfg.language, source: "config" };
  const detected = detectSystemLanguage(env, platform, windowsLocale);
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
 *  的写侧不变量结构化于 management-room.ts 的 nextManagementRooms
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

/** 工具循环中间回合聚合(issue #235):默认开 —— 聚合进同一张持续刷新的
 *  活卡;false = 完全旁路,退回逐条旧行为(与旧版逐字节一致)。 */
export function aggregateToolTurns(cfg: MsgBridgeConfig): boolean {
  return cfg.aggregateToolTurns !== false;
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

/** 收养写侧语义(与 managementRoomId 同族)已结构化于 management-room.ts
 *  的 nextManagementRooms(架构候选4);写路径归 ConfigStore.adoptManagementRoom
 *  域入口(2026-10-27 扫描批次)—— 读-改-写收进单一写路径,调用方不再持
 *  cfg 快照判定。 */

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

  /** Shallow-merge a patch into the in-memory config and persist it.
   *  Persist failure never throws into the message pipeline: the in-memory
   *  copy stays authoritative and the next successful update re-persists
   *  (setup's direct saveConfig call still fails loudly on purpose). */
  update(patch: Partial<MsgBridgeConfig>): void {
    this.config = { ...this.config, ...patch };
    try {
      saveConfig(this.config);
    } catch (err) {
      console.warn(`config persist failed (memory copy stays authoritative): ${(err as Error).message}`);
    }
  }

  /** space 域深更新(2026-10-27 扫描批次 C):space 是唯一由多个调用方分域
   *  簿记的嵌套对象(roomId / invitedUsers / managementInvitedUsers),此前
   *  各写点手动展开 space 对象 —— 展开陈旧快照(await 窗口里 capture 的
   *  cfg)会把并发写方的字段静默丢掉。patch 可以是对象或函数:函数式拿到
   *  此刻权威 space,返回段立即合并;读-改-写收进单一写路径,中间无 await
   *  可插。其余嵌套对象无此问题:matrix/auth 由 setup 向导与 auth 模块整体
   *  持有(authoritative 全量替换),不走这里。 */
  updateSpace(patch: Partial<SpaceConfig> | ((space: SpaceConfig) => Partial<SpaceConfig>)): void {
    const current = this.config.space ?? {};
    const slice = typeof patch === "function" ? patch(current) : patch;
    this.update({ space: { ...current, ...slice } });
  }

  /** 管理房收养域入口(扫描批次 G 收尾):读-改-写收进 store,写方不再
   *  持 cfg 快照做判定(陈旧快照会让并发收养互相踩)。判定委托
   *  management-room.ts 的 nextManagementRooms;false = 已有管理房,拒绝
   *  再写(与真写一样落盘持久化,幂等语义不变)。 */
  adoptManagementRoom(roomId: string): boolean {
    const rooms = nextManagementRooms(this.config.managementRooms, roomId);
    if (rooms === undefined) return false;
    this.update({ managementRooms: rooms });
    return true;
  }
}
