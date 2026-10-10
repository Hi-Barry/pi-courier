/**
 * Audit wiring through the router (issue #124): every registered sensitive
 * action appends exactly one line via the injected AuditLog — pairing
 * outcomes, /trusted //revoke, `!` bash, /stop queue clears, backlog batch
 * execution, /login family, /pmctl rm, /reload. Plus the #124 injection
 * source labels (attachment header + quote prefix) as pure-function pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuditEntry } from "../src/audit/audit-log";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { ConfigStore } from "../src/config";
import { withAttachmentPrefix, withQuotePrefix, createMessageRouter } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

function makeMsg(overrides: Partial<ExternalMessage> & { text?: string } = {}): ExternalMessage {
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

function makeRouter(auditLines: AuditEntry[]): { router: ReturnType<typeof createMessageRouter>; rpc: PiRpc } {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const rpc = {
    prompt,
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
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(rpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: false,
    allRpcs: vi.fn().mockReturnValue([rpc]),
    roomForRpc: vi.fn().mockReturnValue(undefined),
  } as unknown as ProjectManager;
  const store = new ConfigStore({});
  const auth = new ChallengeAuth(() => {}, () => {});
  auth.loadFromConfig({ trustedUsers: ["matrix:@barry:server"], adminUserId: "matrix:@barry:server", channels: {} });
  const roomOps = { getBotUserId: vi.fn().mockReturnValue("@bot:server") } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });
  const login = {
    isPending: vi.fn().mockReturnValue(false),
    deliver: vi.fn().mockResolvedValue(false),
    authStatus: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    startLogin: vi.fn().mockResolvedValue(undefined),
  };
  const router = createMessageRouter({
    projectManager,
    auth,
    sendReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn(),
    roomOps,
    store,
    pmctl,
    login: login as never,
    audit: {
      append: (event: string, actor: string, chatId: string, detail?: string) =>
        auditLines.push({ ts: Date.now(), event, actor, chatId, detail }),
    } as never,
  });
  return { router, rpc };
}

describe("audit wiring (issue #124)", () => {
  let lines: AuditEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    lines = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("/trusted → trust.list; wrong pairing code → pairing.wrong", async () => {
    const { router } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ text: "/trusted" }));
    await router.handleIncoming(makeMsg({ userId: "@stranger:server", username: "stranger", text: "000000" }));
    expect(lines.map((l) => l.event)).toEqual(["trust.list", "pairing.wrong"]);
    expect(lines[0]!.actor).toBe("matrix:@barry:server");
    expect(lines[1]!.detail).toContain("@stranger");
  });

  it("`!ls` → bash.exec with the raw command as detail", async () => {
    const { router } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ text: "! ls -la" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event).toBe("bash.exec");
    expect(lines[0]!.detail).toBe("! ls -la");
  });

  it("/stop that really cleared → queue.clear with the count", async () => {
    const { router, rpc } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ messageId: "bind" }));
    router.handleEvent({ type: "queue_update", steering: ["排队一", "排队二"], followUp: [] }, rpc);
    await router.handleIncoming(makeMsg({ text: "/stop" }));
    const cleared = lines.find((l) => l.event === "queue.clear");
    expect(cleared?.detail).toContain("/stop cleared 2 queued message(s)");
  });

  it("执行 on offline backlog → backlog.execute with the count (#113 回填)", async () => {
    const { router } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ replayed: true, text: "积压甲" }));
    await vi.advanceTimersByTimeAsync(5_000);
    await router.handleIncoming(makeMsg({ text: "执行" }));
    expect(lines.some((l) => l.event === "backlog.execute" && l.detail!.includes("delivering 1 offline backlog"))).toBe(true);
  });

  it("/auth → login.flow; /pmctl rm → pmctl.rm; /reload → reload", async () => {
    const { router } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ text: "/auth" }));
    await router.handleIncoming(makeMsg({ text: "/pmctl rm proj-a" }));
    await router.handleIncoming(makeMsg({ text: "/reload" }));
    expect(lines.map((l) => l.event)).toEqual(["login.flow", "pmctl.rm", "reload"]);
    expect(lines[1]!.detail).toBe("/pmctl rm proj-a");
  });

  it("ordinary conversation leaves NO audit line", async () => {
    const { router } = makeRouter(lines);
    await router.handleIncoming(makeMsg({ text: "普通聊天" }));
    expect(lines).toHaveLength(0);
  });
});

describe("injection source labels (issue #124)", () => {
  it("attachment header names the sender and the room", () => {
    const out = withAttachmentPrefix("看看", [{ path: "/tmp/a.png", bytes: 3 } as never], { user: "@phone2:s", room: "!proj:s" });
    expect(out).toContain("用户 @phone2:s 在房间 !proj:s 发来附件");
    expect(out).toContain("- /tmp/a.png");
    expect(out.endsWith("看看")).toBe(true);
  });

  it("attachment header without source keeps the legacy wording", () => {
    const out = withAttachmentPrefix("hi", [{ path: "/tmp/a.png", bytes: 3 } as never]);
    expect(out).toContain("用户发来附件");
  });

  it("quote prefix frames the excerpt as third-party history", () => {
    expect(withQuotePrefix("这个是什么", { username: "carol", excerpt: "旧消息" })).toBe(
      "「引用自 @carol 的历史消息:旧消息」\n这个是什么"
    );
  });
});
