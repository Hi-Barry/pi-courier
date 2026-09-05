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
  /**
   * Quoted-message excerpt (issue #56 票5): when this message is a Matrix
   * reply to a known historical message, the transport attaches a short
   * cleaned quote of it. Undefined when there is no reply relation or the
   * referenced event is not in the per-room cache (silent downgrade).
   */
  quoted?: { username: string; excerpt: string };
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
  /**
   * Element 空间(Space)组织视图——把本实例创建的房间收纳进一个私有空间,
   * 便于在 Element 中管理。空间本身仍是展示层;信任用户的房间权限
   * (自动管理员,见 #42)由统一补权负责,与是否挂入空间无关。
   */
  space?: SpaceConfig;
  /**
   * 信任用户自动管理员(#42)的提权簿记:曾被实际从低于管理员提升为
   * PL 100 的命名空间用户 ID(去重)。后续撤销/降权(票3)以它圈定范围。
   * 注意:旧特例(/pmctl new 仅提升发起人)时代产生的管理员不在簿记,
   * 这是文档写明的存量包袱。
   */
  powerElevatedUsers?: string[];
}

/** @see MsgBridgeConfig.space */
export interface SpaceConfig {
  /** 启用开关(仅多项目模式生效;由 setup 写入)。 */
  enabled?: boolean;
  /** 已创建空间的房间 ID(幂等标记;缺省 = 尚未创建,启动时懒创建,
   *  失败降级为无空间模式并在下次启动重试)。 */
  roomId?: string;
  /** 已向其发出过空间邀请的命名空间用户 ID(含已拒绝者)——
   *  每人只邀请一次,不重复打扰;未入列的信任用户由启动自愈补邀。 */
  invitedUsers?: string[];
  /** 已向其发出过管理房间邀请的命名空间用户 ID(含已拒绝者)——与
   *  invitedUsers 同构:每人只邀请一次;未入列的信任用户由启动自愈补邀。
   *  仅空间模式使用;降级模式的认养管理 DM 不向任何人发邀请。 */
  managementInvitedUsers?: string[];
}

/**
 * Where a reply goes: which chat, over which transport (message I/O), and
 * who prompted. RoomBindings attach one of these per pi process.
 */
export interface ReplyTarget {
  chatId: string;
  transport: string;
  username: string;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
