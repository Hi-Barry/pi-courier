/**
 * Shared test helpers — deliberately not *.test.ts so vitest ignores it.
 *
 * Router fixture factory (架构候选2): the single home for the router test
 * assembly — makeMsg, the full fake rpc, the six-field fake ProjectManager,
 * real auth/pmctl wiring, the audit recorder. Slices mirror the production
 * deps optionality: an absent slice = the feature is off, byte-for-byte the
 * "Absent = …" contract on MessageRouterDeps. Escape hatches (rpc,
 * projectManager, extra) keep file-specific fakes local instead of growing
 * the factory's interface for one-off cases.
 */
import { vi } from "vitest";
import { type AuditEntry } from "../src/audit/audit-log";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import { type MessageRouter, type MessageRouterDeps, createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

/** Capture every console line (log + error) into one ordered buffer. */
export function captureConsole(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

/** One inbound Matrix-shaped message; overrides win, ids are unique by default. */
export function makeMsg(overrides: Partial<ExternalMessage> & { text?: string } = {}): ExternalMessage {
  const { text = "hi", ...rest } = overrides;
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    payload: { kind: "text", text },
    isGroupChat: false,
    wasMentioned: false,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(),
    ...rest,
  };
}

/** The full fake rpc most router tests need: streaming idle, restart hook sink,
 *  bash, and a requireClient carrying the queue-clear COMPAT surface. Files
 *  with a bespoke rpc (stateful models, bash mocks, restart dispatch) pass
 *  their own and never touch this one. */
export function makeFakeRpc(): PiRpc {
  return {
    prompt: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
    label: undefined,
    onEvent: vi.fn(),
    onRestarted: vi.fn().mockReturnValue(() => {}),
    bash: vi.fn().mockResolvedValue({ ok: true, text: "done" }),
    requireClient: vi.fn().mockReturnValue({
      abort: vi.fn().mockResolvedValue(undefined),
      waitForIdle: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ success: true, data: { steering: ["排队一", "排队二"], followUp: [] } }),
      newSession: vi.fn().mockResolvedValue({ cancelled: false }),
      getState: vi.fn().mockResolvedValue({ isStreaming: false, model: { id: "m" }, pendingMessageCount: 0 }),
    }),
  } as unknown as PiRpc;
}

export interface RouterFixtureOptions {
  /** 缺省空配置;要预置配置(fallback 链、inbox 模式等)时传入。 */
  store?: ConfigStore;
  /** 信任名单,缺省只有 barry;channels 缺省全关。 */
  trusted?: string[];
  channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  /** 逃生舱:整体替换默认完整 fake rpc(状态化模型、bash mock、restart 分派等)。 */
  rpc?: PiRpc;
  /** 逃生舱:整体替换默认 fake ProjectManager(per-room 分派、多进程场景)。 */
  projectManager?: ProjectManager;
  /** 缺省 vi.fn;传自定义实现时被包成 vi.fn(闭包捕获照常工作)。 */
  sendReply?: (chatId: string, transport: string, text: string) => Promise<void>;
  /** true → 注入 auditLines 记录器;缺省不注入 = 零审计(生产 Absent 语义)。 */
  audit?: boolean;
  /** 缺省不注入 = login 特性关;要 /login 家族语义时传 mock runtime 形态。 */
  login?: MessageRouterDeps["login"];
  /** 逃生舱:其余可选 deps(reminders/queueSnapshots/attachmentsLedger/…)原样透传。 */
  extra?: Partial<MessageRouterDeps>;
}

export interface RouterFixture {
  router: MessageRouter;
  rpc: PiRpc;
  projectManager: ProjectManager;
  store: ConfigStore;
  auth: ChallengeAuth;
  roomOps: RoomOps;
  pmctl: PmctlController;
  sendReply: ReturnType<typeof vi.fn>;
  /** audit: true 时是注入 router 的那一只;否则恒空、不注入。 */
  auditLines: AuditEntry[];
}

/** Assemble a router over fakes — the one place router test wiring lives. */
export function makeRouterFixture(options: RouterFixtureOptions = {}): RouterFixture {
  const rpc = options.rpc ?? makeFakeRpc();
  const projectManager =
    options.projectManager ??
    ({
      getRpcForRoom: vi.fn().mockReturnValue(rpc),
      isProjectRoom: vi.fn().mockReturnValue(false),
      labelForRoom: vi.fn().mockReturnValue(undefined),
      isMultiProject: false,
      allRpcs: vi.fn().mockReturnValue([rpc]),
      roomForRpc: vi.fn().mockReturnValue(undefined),
      projectFallbacks: vi.fn().mockReturnValue(undefined),
    } as unknown as ProjectManager);
  const store = options.store ?? new ConfigStore({});
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({
    trustedUsers: options.trusted ?? ["matrix:@barry:server"],
    adminUserId: "matrix:@barry:server",
    channels: options.channels ?? {},
  });
  const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const sendReply = vi.fn(options.sendReply ?? (async () => {}));
  const auditLines: AuditEntry[] = [];
  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply,
    sendTyping: vi.fn(),
    roomOps,
    store,
    pmctl,
    ...(options.login ? { login: options.login } : {}),
    ...(options.audit
      ? {
          audit: {
            append: (event: string, actor: string, chatId: string, detail?: string) =>
              auditLines.push({ ts: Date.now(), event, actor, chatId, detail }),
          } as never,
        }
      : {}),
    ...options.extra,
  });
  return { router, rpc, projectManager, store, auth, roomOps, pmctl, sendReply, auditLines };
}
