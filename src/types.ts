/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Unique message identifier */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
}

/**
 * Configuration for pi-courier
 */
export interface MsgBridgeConfig {
  matrix?: {
    homeserverUrl: string;
    accessToken: string;
    encryption?: boolean;
  };
  auth?: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  };
  hideToolCalls?: boolean;
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
  /** pi 的工作目录(pi 子进程的 cwd;`--workdir` 参数优先) */
  workdir?: string;
  /**
   * 实例名/机器名(可选):用于区分多台部署。默认取 os.hostname()。
   * 管理房间名与首聊说明会带上它,方便跨机识别"哪个账号/哪台机器"。
   */
  instanceName?: string;
  /**
   * 多工程模式(默认 false = 单工程简单模式)。
   * - false:一个账号 ↔ 一个 pi;所有房间直接连默认 workdir,不做管理房间/项目房间,/pmctl 不可用。
   * - true:启用多项目(管理房间、项目房间隔离、/pmctl、实例名)。
   * 用 /multiproject on|off 切换(改配置,重启生效)。
   */
  multiProject?: boolean;
  /** pi 会话存储目录(对应 pi 的 --session-dir) */
  sessionDir?: string;
  /** 显式指定 pi 的 cli.js 路径(默认:PI_CLI_PATH → which pi → 本地 node_modules) */
  cliPath?: string;
  /** 日志级别:debug | info | warn | error(默认 info;`pi-courier logs --level debug` 可查看全量) */
  logLevel?: string;
  /**
   * 固定设备 ID(仅密码登录适用):重跑 setup 时复用同一个设备,
   * 避免换 token 后设备身份变化导致 M_BAD_JSON / 历史密钥丢失。
   * 由 setup 生成并持久化;删除此字段可重新生成(新设备身份)。
   */
  deviceId?: string;
  /**
   * 多项目映射:房间 ID → 项目配置(名称 + 工作目录)。
   * 每个映射的房间独立跑一个 pi 进程(独立 cwd/会话/bash 环境)。
   * 未映射的私聊(DM/管理房间)走默认 workdir。
   */
  projects?: Record<string, { name?: string; workdir: string }>;
  /**
   * 已初始化为"项目管理"房间的 DM 房间 ID 列表(幂等标记,
   * 避免重启后重复改名/重复发送使用说明)。
   */
  managementRooms?: string[];
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
