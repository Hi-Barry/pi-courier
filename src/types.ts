/**
 * Saved attachment reference (issue #66 票1): the transport has already
 * downloaded the bytes to disk before the message enters the router —
 * the path is absolute and readable by the pi subprocess.
 */
export interface MessageAttachment {
  /** Absolute path of the saved file */
  path: string;
  /** Sanitized original filename (hash prefix + safe body) */
  filename: string;
  /** Size in bytes */
  bytes: number;
}

/**
 * 消息载荷判别联合(spec #72 票1/C3):一份消息只可能是四种之一,互斥由构造
 * 保证——不再依赖"这些可选字段不能同时出现"的注释约定。
 */
export type MessagePayload =
  /** 普通文本(含引用摘录——只有文本消息才携带对更早消息的回复语境) */
  | { kind: "text"; text: string; quoted?: { username: string; excerpt: string } }
  /** 附件已落盘,路径待 router 注入下一条 prompt */
  | { kind: "media"; saved: MessageAttachment[] }
  /** 附件处理失败(下载/解密/超限),reason 已是可直接回执的文案 */
  | { kind: "mediaError"; reason: string }
  /** 有 body 但不认识的非文本类型(如 m.location),礼貌提示路径 */
  | { kind: "unsupported"; msgtype: string };

/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
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
   * 离线积压标记(issue #113 离线收件箱):true = 本条来自重启/断线窗口的
   * 同步回放,且台账确认从未受理过。router 据此缓冲并征询,不直接执行。
   * 只在 transport 的积压路径上置位;实时消息与「执行」后的再注入都不带。
   */
  replayed?: boolean;
  /** 载荷(spec #72 票1/C3):文本、附件、附件失败或不支持类型,四选一 */
  payload: MessagePayload;
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
  /**
   * 离线收件箱(issue #113):重启/断线窗口里收到的、台账确认没处理过的
   * 消息怎么办。
   * - "confirm"(默认):按房间汇总发征询,回「执行」按序处理 /「忽略」丢弃;
   * - "auto":启动收敛后发一条告知,随即按序执行;
   * - "off":行为与 0.4.0 逐字节一致(stale 一律丢弃,不查台账不征询)。
   */
  inbox?: {
    mode?: "confirm" | "auto" | "off";
  };
  /** 交接卡(issue #122):/new 前自动 TL;DR。onNew 默认关 —— 自动出卡是
   *  一次真实模型调用,成本敏感用户零成本升级路径就是不开它。 */
  recap?: {
    onNew?: boolean;
  };
  auth?: {
    trustedUsers?: string[];
    /** 访客档(issue #120):能对话、碰不了危险命令。MXID,格式与
     *  trustedUsers 同;v1 手编配置 + 重启生效(与 projects 字段同策略)。 */
    guestUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  };
  hideToolCalls?: boolean;
  /**
   * 工具循环中间回合聚合(issue #235):默认开启 —— 中间回合不再逐条刷屏,
   * 而是聚合进同一张「工作中」的活卡持续就地刷新(Matrix MSC2676 消息编辑),
   * 终答回合仍是独立新消息。false = 完全旁路,与旧版逐条发送逐字节一致。
   */
  aggregateToolTurns?: boolean;
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
  projects?: Record<string, ProjectConfig>;
  /**
   * 模型降级链(issue #121):连续 N 轮 turn 彻底失败(pi auto-retry 耗尽后
   * 仍 error,默认 2)时按序自动切换的备用模型,`provider/id` 形式(与
   * /model 参数同语法)。空/缺省 = 功能关,行为与旧版逐字节一致。
   * 项目房可用 projects[].fallbacks 覆盖全局链(项目链优先)。
   */
  modelFallbacks?: string[];
  /**
   * 已初始化为"项目管理"房间的 DM 房间 ID 列表(幂等标记,
   * 避免重启后重复改名/重复发送使用说明)。
   */
  managementRooms?: string[];
  /**
   * 空间套(风景)版本簿记(spec #84 分套记账):落后于 space-identity.ts 的
   * AVATAR_SET_VERSION.space 时,启动自愈把空间套管辖的房间一次性无条件
   * 刷成新图(此后恢复"只补缺不覆盖")。缺省视为未迁移——含只带旧
   * avatarPoolVersion 的 0.1.49 及更早部署。
   */
  spaceAvatarVersion?: number;
  /**
   * 房间套(小屋,含管理房间专属图)版本簿记:语义同 spaceAvatarVersion,
   * 管辖范围为项目房间与管理房间。
   */
  roomAvatarVersion?: number;
  /**
   * agent 套(bot 账号 profile 头像)版本簿记(spec #84 分套记账):落后于
   * space-identity.ts 的 AVATAR_SET_VERSION.agent 时,启动自愈无条件设置
   * bot 头像(不论当前头像是谁设的),成功后记账,此后恢复"只补缺不覆盖"。
   * 缺省视为未迁移。
   */
  agentAvatarVersion?: number;
  /**
   * 自定义空间头像的图片路径(spec #84 v5 用户覆盖):配置后启动自愈按
   * 「配置即期望状态」维护空间头像——图片内容(sha256)或房间当前头像与
   * 簿记不符时重新上传覆盖,而非「只补缺」。缺省 = 走内置图池。
   * 路径支持 ~ 展开与相对 ~/.pi/ 的相对路径;格式按扩展名识别
   * (png/jpg/jpeg/webp/gif)。文件缺失/上传失败时 warn 并回落内置图池逻辑。
   */
  spaceAvatar?: string;
  /** 自定义 bot 头像的图片路径:语义同 spaceAvatar,作用于 bot 账号
   * profile 头像(本字段配置后无条件维护,盖过 agent 套的「只补缺」)。 */
  botAvatar?: string;
  /**
   * 自定义头像簿记:空间头像最近一次上传的内容指纹与 mxc URL。
   * 内部字段,由启动自愈维护,勿手编。
   */
  spaceAvatarRef?: AvatarCustomRef;
  /** 自定义头像簿记:bot profile 头像的指纹与 mxc URL。内部字段,勿手编。 */
  botAvatarRef?: AvatarCustomRef;
  /**
   * 自定义头像簿记:项目房间 roomId → 最近一次上传的指纹与 mxc URL。
   * 内部字段,由启动自愈维护,勿手编;仅对配置了 projects[].avatar 的房间记账。
   */
  roomAvatarRefs?: Record<string, AvatarCustomRef>;
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
  /**
   * 扩展 UI 提问(issue #54)的兜底超时(分钟,默认 10)。扩展经 RPC 发起的
   * confirm/select/input/editor 悬置超过该时长后,courier 代答 cancelled
   * 并在房间通知。上游对 select/confirm/input 可能自带更短 timeout(二者
   * 不冲突);editor 上游无超时,此项是唯一保证。不进 setup 向导。
   */
  extensionUiTimeoutMinutes?: number;
  /**
   * 界面语言(issue #83):zh | en。缺省时回落链接管:PI_LANGUAGE 环境变量
   * > 本字段 > 系统 locale(LC_ALL > LC_MESSAGES > LANG,zh* → zh) > en。
   * setup 向导首问并写入;运行中不热切换,重启生效。
   */
  language?: "zh" | "en";
  /**
   * bash 回帖输出截断上限(字符;`!`/`!!`//`/bash` 共用,默认 30000)。
   * Matrix 单事件硬上限 64KB,配置值超过 65536 按 65536 钳制 —— 再大回帖
   * 也会被 homeserver 拒。非正数/非有限数视为缺省。不进 setup 向导,
   * 手编配置 + 重启生效(与 extensionUiTimeoutMinutes 同策略)。
   */
  bashOutputLimit?: number;
  /**
   * `!`/`!!`//`/bash` 的执行等待上限(分钟,默认 10)。走自管应答通道
   * (spec #218 票 #220):不经上游 send() 的 30s 写死超时,长命令(构建/
   * 安装/长测试)不再被误报失败。到点后命令被放弃并报超时(含已等待时长)。
   * 非正数/非有限数/亚分钟小数(<1,floor 后成 0ms 立即假超时)视为缺省。
   * 不进 setup 向导,手编配置 + 重启生效。
   */
  bashTimeoutMinutes?: number;
  /**
   * Matrix 附件输入(issue #66):媒体事件的下载落盘配置。
   * directory 缺省 ~/.pi/pi-courier/attachments;maxMb 缺省 10。
   */
  attachments?: {
    /** 附件保存根目录(绝对路径;按房间分子目录) */
    directory?: string;
    /** 单个附件大小上限(MB) */
    maxMb?: number;
  };
  /**
   * 出网代理(spec #201 票 #202):代理 URL,当前版本仅支持
   * http:// 与 https:// 形态。配置优先:未填写时回落认标准环境变量
   * (HTTPS_PROXY/https_proxy、HTTP_PROXY/http_proxy,大小写均认)。
   * 优先级与 scheme 校验统一由 src/proxy.ts 的 resolveProxySettings 解释,
   * 手编错误(如 socks5://)在启动解析时即报错停下(双语提示)。
   */
  proxy?: string;
  /**
   * 出网代理豁免列表(spec #201 票 #202):不经代理直连的目标(主机名、
   * 域名后缀、IP/网段),透传给各消费方(request / undici)按各自惯例
   * 解释,桥不做自己的匹配逻辑。仅在代理生效时有意义;未填写即无豁免
   * (以配置为准,不回落环境变量 NO_PROXY)。
   */
  noProxy?: string[];
  /**
   * 进程韧性配置段(spec #247 票02):心跳、水位、拉起等自愈参数。每条
   * 默认值单点解释在 config.ts 派生函数族,缺省/非法值回落默认,手编配置
   * + 重启生效(与 bashTimeoutMinutes 同策略)。看门狗侧的「多久算死」
   * 过期秒刻意不在本段 —— 单点归属看门狗脚本常量(spec #247 L2 决策,
   * 文档与脚本注释互指换算关系)。
   */
  resilience?: {
    /**
     * 心跳写入间隔(秒,默认 30):桥内周期自检 tick 的节拍,也是看门狗
     * 过期秒的换算基线(默认 180 秒 = 6 × 30)。非正数/非有限数视为缺省。
     */
    heartbeatIntervalSeconds?: number;
    /**
     * 磁盘软阈值(MB,默认 2048):剩余空间跌破发恰好一条告警(状态翻转
     * 去重,回升发恢复)。恒被钳在硬阈值之上(手编倒挂时按硬阈值 +1)。
     */
    diskSoftMb?: number;
    /**
     * 磁盘硬阈值(MB,默认 512):低于即退出 —— 启动期只写死因日志即退
     * (先行于一切网络接线,不发管理房留言);运行期沿「留言 + 非零码
     * 优雅退出」链。非正数/非有限数视为缺省。
     */
    diskHardMb?: number;
    /**
     * 堆告警百分比(默认 80):heapUsed 占堆上限比例超限发一条告警
     * (状态翻转去重)。钳制到 [1, 100]。
     */
    heapAlertPercent?: number;
  };
}

/**
 * 项目条目(issue #119):workdir 之外,项目可记住自己的运行时默认值。
 * 预设只在进程(懒)启动/重启握手完成后应用一次 —— "开机默认,不是锁定",
 * 此后的 /model、/thinking 手动切换不受干扰,直到下一次重启回到预设。
 */
/** 自定义头像簿记条目:最近一次上传的内容指纹(sha256,hex)与 mxc URL。 */
export interface AvatarCustomRef {
  sha256: string;
  mxc: string;
}

export interface ProjectConfig {
  name?: string;
  workdir: string;
  /** 预设模型,`provider/id`(与 /model 参数同语法;裸 id 按可用模型列表解析) */
  model?: string;
  /** 预设思考级别:off|minimal|low|medium|high|xhigh|max(缺省回落全局现状) */
  thinkingLevel?: string;
  /** 项目降级链(issue #121):覆盖全局 modelFallbacks;条目须为 `provider/id` */
  fallbacks?: string[];
  /** 自定义项目房间头像的图片路径(语义同 spaceAvatar,仅本房间生效)。 */
  avatar?: string;
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
