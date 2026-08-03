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
 * Configuration for msg-bridge extension
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
  /** pi 会话存储目录(对应 pi 的 --session-dir) */
  sessionDir?: string;
  /** 显式指定 pi 的 cli.js 路径(默认:PI_CLI_PATH → which pi → 本地 node_modules) */
  cliPath?: string;
  /** 日志级别:debug | info | warn | error(默认 info;`pi-courier logs --level debug` 可查看全量) */
  logLevel?: string;
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
