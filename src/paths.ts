/**
 * 跨平台目录布局解析(spec #258 票01,决策表冻结于 issue #259 与探索笔记)。
 *
 * 为什么是纯函数:布局决策(配置/数据/状态三分离)要求所有路径从单一来源
 * 派生,而组合根(standalone.ts)之外的模块从此不再各自取 homedir —— 输入
 * `{ platform, homedir, env }` 全部注入,测试不读真实 HOME,票02 的迁移器
 * 也能对「旧布局/新布局」各解析一次做对照。
 *
 * 平台分支(冻结,勿在此之外再发散):
 *  - win32:  config=~/.pi(沿用 pi CLI 既有约定);data=%APPDATA%\pi-courier
 *            (APPDATA 缺失回退 ~/AppData/Roaming/pi-courier);state=<data>\state
 *  - linux:  config=$XDG_CONFIG_HOME/pi-courier(缺省 ~/.config/pi-courier)
 *            data=$XDG_DATA_HOME/pi-courier(缺省 ~/.local/share/pi-courier)
 *            state=$XDG_STATE_HOME/pi-courier(缺省 ~/.local/state/pi-courier)
 *  - darwin: data=~/Library/Application Support/pi-courier;config=~/.config
 *            (与 linux 同惯例);state=<data>/state(只求解析正确,不真机验收)
 *  其余 POSIX 平台按 linux 分支处理(XDG 惯例通用)。
 *
 * 子项叶子名去 `pi-courier-` 前缀:新家目录(pi-courier)已带应用名,避免
 * `pi-courier/pi-courier-matrix-store.json` 这类双前缀。刻意保留旧名的例外:
 * configDir 下 `pi-courier.json` 与 stateDir 下 `pi-courier.lock`(票03 换线
 * 前与存量用户可见文案一致,改名不在本 spec 范围)。
 */

import * as path from "node:path";

/** 布局解析输入,全注入(platform/homedir/env);不直接触碰运行环境。 */
export interface LayoutInput {
  /** 平台(组合根传 process.platform;测试传分支字面量)。 */
  platform: NodeJS.Platform;
  /** 用户家目录(os.homedir() 的注入缝)。 */
  homedir: string;
  /** 环境变量(APPDATA 与三个 XDG 变量的注入缝;undefined 视为缺失)。 */
  env: Record<string, string | undefined>;
}

/** 三大根目录;派生路径(锁、日志、Matrix 存储等)见 `Layout`。 */
export interface DirLayout {
  /** 配置根:pi-courier.json、agent/sessions(RPC 会话,原样不动)。 */
  configDir: string;
  /** 数据根:Matrix 存储/加密库/附件等「内容资产」。 */
  dataDir: string;
  /** 状态根:心跳/审计/台账/锁/日志等「可重建运行痕迹」。 */
  stateDir: string;
}

/** 完整布局 = 三大根 + 全量派生路径。派生只认解析后的根(根变了叶子跟着走)。 */
export interface Layout extends DirLayout {
  /** 配置文件(configDir/pi-courier.json;名字与存量约定一致,不带目录名前缀)。 */
  configPath: string;
  /** RPC 会话默认目录(configDir/agent/sessions)。刻意原位不动:会话在途
   *  引用该路径,迁移它会断网会话,超出 spec #258 范围。 */
  agentSessionsDir: string;
  /** Matrix 消息存储(dataDir/matrix-store.json;旧名 pi-courier-matrix-store.json)。 */
  matrixStorePath: string;
  /** Matrix 加密库存放目录(dataDir/matrix-crypto)。 */
  matrixCryptoDir: string;
  /** 附件落地目录(dataDir/attachments)。 */
  attachmentsDir: string;
  /** 单实例锁(stateDir/pi-courier.lock)。锁从 ~/.pi 挪到 stateDir:它本质是
   *  运行痕迹而非配置,旧锁不迁移、在新位置重建(票02/03 负责时序)。 */
  lockPath: string;
  /** 心跳文件(stateDir/heartbeat.json;spec #247 看门狗按此读)。 */
  heartbeatPath: string;
  /** 审计日志(stateDir/audit.jsonl)。 */
  auditLogPath: string;
  /** 事件台账(stateDir/event-ledger.jsonl)。 */
  eventLedgerPath: string;
  /** 消息队列快照(stateDir/queue-snapshots.json)。 */
  queueSnapshotsPath: string;
  /** 看门狗告警去重戳(stateDir/watchdog-alert-stamp)。 */
  watchdogAlertStampPath: string;
  /** 状态日志目录(stateDir/logs)。 */
  stateLogsDir: string;
  /** 桥运行日志(stateLogsDir/run.log;旧 ~ 或 ~/.pi 下散落的 run.log 的新家)。 */
  runLogPath: string;
}

/** XDG base-dir 语义:变量「未设置或空串」一律按缺省处理(spec 原文即如此)。 */
function envRoot(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function resolveLayout(input: LayoutInput): Layout {
  const { platform, homedir, env } = input;
  // 分隔符跟随输入平台而非宿主:linux CI 上也能解析出正确的 win32 反斜杠路径。
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  let roots: DirLayout;
  if (platform === "win32") {
    const dataDir = join(
      envRoot(env, "APPDATA") ?? join(homedir, "AppData", "Roaming"),
      "pi-courier",
    );
    roots = { configDir: join(homedir, ".pi"), dataDir, stateDir: join(dataDir, "state") };
  } else if (platform === "darwin") {
    const dataDir = join(homedir, "Library", "Application Support", "pi-courier");
    roots = { configDir: join(homedir, ".config", "pi-courier"), dataDir, stateDir: join(dataDir, "state") };
  } else {
    roots = {
      configDir: join(envRoot(env, "XDG_CONFIG_HOME") ?? join(homedir, ".config"), "pi-courier"),
      dataDir: join(envRoot(env, "XDG_DATA_HOME") ?? join(homedir, ".local", "share"), "pi-courier"),
      stateDir: join(envRoot(env, "XDG_STATE_HOME") ?? join(homedir, ".local", "state"), "pi-courier"),
    };
  }
  const { configDir, dataDir, stateDir } = roots;
  const stateLogsDir = join(stateDir, "logs");
  return {
    ...roots,
    configPath: join(configDir, "pi-courier.json"),
    agentSessionsDir: join(configDir, "agent", "sessions"),
    matrixStorePath: join(dataDir, "matrix-store.json"),
    matrixCryptoDir: join(dataDir, "matrix-crypto"),
    attachmentsDir: join(dataDir, "attachments"),
    lockPath: join(stateDir, "pi-courier.lock"),
    heartbeatPath: join(stateDir, "heartbeat.json"),
    auditLogPath: join(stateDir, "audit.jsonl"),
    eventLedgerPath: join(stateDir, "event-ledger.jsonl"),
    queueSnapshotsPath: join(stateDir, "queue-snapshots.json"),
    watchdogAlertStampPath: join(stateDir, "watchdog-alert-stamp"),
    stateLogsDir,
    runLogPath: join(stateLogsDir, "run.log"),
  };
}
