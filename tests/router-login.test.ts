/**
 * Headless login through the router (issue #55, spec #51 ticket 4).
 *
 * /login (list + start), the gates (admin + management room; single-project
 * DM counts as management room), the api_key round-trip over plain messages,
 * 「取消」, capture priority over pending extension_ui questions, /logout,
 * /auth and /reload all. A REAL LoginManager with a MOCK runtime factory is
 * injected — no test touches ~/.pi.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuthInteraction, Credential, CredentialInfo } from "@earendil-works/pi-ai";
import { ChallengeAuth } from "../src/auth/challenge-auth";
import { LoginManager, type LoginRuntime } from "../src/auth/headless-login";
import { ConfigStore } from "../src/config";
import { createMessageRouter, type ExtensionUIRequestView } from "../src/rpc/message-router";
import { PmctlController } from "../src/rpc/pmctl-controller";
import type { ExtensionUIResponsePayload, PiRpc } from "../src/rpc/pi-rpc";
import type { ProjectManager } from "../src/rpc/project-manager";
import type { RoomOps } from "../src/transports/interface";
import type { ExternalMessage } from "../src/types";

function makeMsg(overrides: Partial<ExternalMessage> = {}): ExternalMessage {
  return {
    chatId: "!dm:server",
    transport: "matrix",
    userId: "@barry:server",
    username: "barry",
    content: "hi",
    isGroupChat: false,
    wasMentioned: false,
    messageId: "m1",
    timestamp: new Date(),
    ...overrides,
  };
}

function makeRpc(label: string | undefined, isStreaming = false, onExtensionResponse?: (payload: ExtensionUIResponsePayload) => void) {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const rpc = {
    label,
    prompt,
    getState: vi.fn().mockResolvedValue({ isStreaming, model: { id: "m" }, pendingMessageCount: 0 }),
    restart: vi.fn().mockResolvedValue(undefined),
    respondExtensionUI: vi.fn().mockImplementation(async (payload: ExtensionUIResponsePayload) => {
      onExtensionResponse?.(payload);
    }),
    onEvent: vi.fn(),
  } as unknown as PiRpc;
  return { rpc, prompt };
}

interface FixtureOptions {
  multiProject?: boolean;
  /** Extra trusted (but NOT admin) user for the gate tests. */
  secondTrusted?: string;
}

/**
 * Fixtures mirroring the router-extension-ui pattern, extended for login:
 * the rpc mocks carry getState/restart (idle-restart assertions), the project
 * manager exposes allRpcs, and a real LoginManager runs over a mock runtime.
 */
function makeFixtures(opts: FixtureOptions = {}, runtime?: LoginRuntime) {
  const replies: Array<{ chatId: string; transport: string; text: string }> = [];
  const extensionResponses: ExtensionUIResponsePayload[] = [];
  const sendReply = async (chatId: string, transport: string, text: string) => {
    replies.push({ chatId, transport, text });
  };
  const dm = makeRpc(undefined, false, (payload) => extensionResponses.push(payload));
  const busy = makeRpc("proj-busy", true);
  const defaultRpc = dm.rpc;
  const busyRpc = busy.rpc;
  const allRpcs = [defaultRpc, busyRpc];
  const projectManager = {
    getRpcForRoom: vi.fn().mockReturnValue(defaultRpc),
    isProjectRoom: vi.fn().mockReturnValue(false),
    labelForRoom: vi.fn().mockReturnValue(undefined),
    isMultiProject: opts.multiProject === true,
    registerProject: vi.fn(),
    listProjects: vi.fn().mockReturnValue([]),
    renameProject: vi.fn(),
    stopAll: vi.fn(),
    allRpcs: vi.fn().mockReturnValue(allRpcs),
  } as unknown as ProjectManager;
  const store = new ConfigStore(opts.multiProject ? { multiProject: true, managementRooms: ["!mgmt:server"] } : {});
  const auth = new ChallengeAuth(
    () => {},
    () => {}
  );
  auth.loadFromConfig({
    trustedUsers: ["matrix:@barry:server", ...(opts.secondTrusted ? [opts.secondTrusted] : [])],
    adminUserId: "matrix:@barry:server",
    channels: {},
  });
  const sendTyping = vi.fn(async (_chatId: string, _transport: string): Promise<void> => {});
  const roomOps = {
    getBotUserId: vi.fn().mockReturnValue("@bot:server"),
  } as unknown as RoomOps;
  const pmctl = new PmctlController({ projectManager, roomOps, store });

  const login = new LoginManager({
    sendReply,
    allRpcs: () => allRpcs,
    runtimeFactory: async () =>
      runtime ?? {
        login: vi.fn(async () => ({ type: "api_key", key: "written" }) as Credential),
        logout: vi.fn(async () => {}),
        listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "oauth" }] as CredentialInfo[]),
      },
  });
  const router = createMessageRouter({ projectManager, auth, sendReply, sendTyping, roomOps, store, pmctl, login });
  const lastReply = () => replies.at(-1)!.text;
  const allText = () => replies.map((r) => r.text).join("\n");
  return {
    replies,
    lastReply,
    allText,
    extensionResponses,
    defaultRpc,
    defaultPrompt: dm.prompt,
    busyRpc,
    router,
    store,
    auth,
    login,
  };
}

describe("/login gates (issue #55)", () => {
  it("a trusted non-admin is rejected before anything starts", async () => {
    const fx = makeFixtures({ secondTrusted: "matrix:@other:server" });
    await fx.router.handleIncoming(makeMsg({ userId: "@other:server", username: "other", content: "/login" }));
    expect(fx.lastReply()).toBe("❌ 无权限(仅管理员可管理 provider 登录)");
    await fx.router.handleIncoming(
      makeMsg({ userId: "@other:server", username: "other", content: "/login anthropic api_key" })
    );
    expect(fx.lastReply()).toBe("❌ 无权限(仅管理员可管理 provider 登录)");
  });

  it("in multi-project mode only the management room may log in", async () => {
    const fx = makeFixtures({ multiProject: true });
    // Not the management room → rejected.
    await fx.router.handleIncoming(makeMsg({ content: "/login" }));
    expect(fx.lastReply()).toBe("❌ 登录管理仅可在管理房间使用(单工程模式下与 bot 的私聊即可)");
    // The management room → the listing runs.
    await fx.router.handleIncoming(makeMsg({ chatId: "!mgmt:server", content: "/login" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("可登录 provider"));
  });

  it("in single-project mode a DM counts as the management room; enabled group chats do not", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "/login" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("可登录 provider"));

    const group = makeFixtures();
    // The group must be an authorized channel, otherwise authorization drops
    // the message before the login gate is ever reached (enabled in memory —
    // never through store.update, which would persist to the real config).
    group.auth.enableChannel("!group:server", "trusted-only");
    await group.router.handleIncoming(
      makeMsg({ isGroupChat: true, chatId: "!group:server", content: "/login" })
    );
    expect(group.lastReply()).toBe("❌ 登录管理仅可在管理房间使用(单工程模式下与 bot 的私聊即可)");
  });
});

describe("/login listing and dispatch (issue #55)", () => {
  it("the bare /login lists providers with capability + credential badges", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "/login" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("可登录 provider"));
    const text = fx.lastReply();
    expect(text).toContain("• anthropic — Anthropic(oauth / api_key) ✅ 已认证(oauth)");
    expect(text).toContain("/login <provider> <oauth|api_key>");
  });

  it("/logout checks credentials, then deletes via the runtime", async () => {
    const runtime: LoginRuntime = {
      login: vi.fn(async () => ({ type: "api_key", key: "k" }) as Credential),
      logout: vi.fn(async () => {}),
      listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "oauth" }] as CredentialInfo[]),
    };
    const fx = makeFixtures({}, runtime);
    await fx.router.handleIncoming(makeMsg({ content: "/logout" }));
    expect(fx.lastReply()).toContain("用法: /logout <provider>");

    await fx.router.handleIncoming(makeMsg({ content: "/logout openai" }));
    expect(fx.lastReply()).toContain("openai 没有已保存的凭据");
    expect(asMock(runtime.logout)).not.toHaveBeenCalled();

    await fx.router.handleIncoming(makeMsg({ content: "/logout anthropic" }));
    expect(asMock(runtime.logout)).toHaveBeenCalledWith("anthropic");
    expect(fx.lastReply()).toContain("✅ 已删除 anthropic 的凭据");
  });

  it("/auth lists the stored credentials", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "/auth" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("• anthropic — oauth"));
  });
});

function asMock(fn: unknown) {
  return fn as ReturnType<typeof vi.fn>;
}

/** A runtime whose login flow asks for an API key (the api_key round-trip). */
function runtimeWithSecretPrompt(): LoginRuntime {
  return {
    login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
      await interaction.prompt({ type: "secret", message: "粘贴你的 Anthropic API key" });
      return { type: "api_key", key: "sk-written" } as Credential;
    }),
    logout: vi.fn(async () => {}),
    listCredentials: vi.fn(async () => [] as CredentialInfo[]),
  };
}

async function startLogin(fx: ReturnType<typeof makeFixtures>): Promise<void> {
  await fx.router.handleIncoming(makeMsg({ content: "/login anthropic api_key" }));
  await vi.waitFor(() => expect(fx.replies[0]!.text).toContain("已开始 anthropic api_key 登录流程"));
  await vi.waitFor(() => expect(fx.replies.at(-1)!.text).toContain("粘贴你的 Anthropic API key"));
}

describe("/login api_key round-trip in the room (issue #55)", () => {
  it("the pasted key becomes the prompt answer; idle rpc restarts, busy rpc is skipped", async () => {
    const fx = makeFixtures({}, runtimeWithSecretPrompt());
    await startLogin(fx);
    expect(fx.allText()).toContain("房间历史"); // the secret warning is present

    await fx.router.handleIncoming(makeMsg({ content: "sk-ant-secret", messageId: "m2" }));

    await vi.waitFor(() => expect(fx.lastReply()).toContain("登录成功"));
    const summary = fx.lastReply();
    expect(summary).toContain("凭据已写入");
    expect(summary).toContain("✅ 已重启 1 个空闲进程: 默认");
    expect(summary).toContain("⚠️ 跳过 1 个忙碌进程: proj-busy(完成后执行 /reload all)");
    expect(fx.defaultRpc.restart).toHaveBeenCalledTimes(1);
    expect(fx.busyRpc.restart).not.toHaveBeenCalled();
    // The key never reached pi as a prompt.
    expect(fx.defaultPrompt).not.toHaveBeenCalled();
  });

  it("「取消」 aborts the flow; no restart happens and later messages prompt normally", async () => {
    const fx = makeFixtures({}, runtimeWithSecretPrompt());
    await startLogin(fx);
    await fx.router.handleIncoming(makeMsg({ content: "取消", messageId: "m2" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("🛑 已取消 anthropic 的登录流程"));
    expect(fx.allText()).not.toContain("登录成功");
    expect(fx.defaultRpc.restart).not.toHaveBeenCalled();

    // The room is free again — plain messages go to pi.
    await fx.router.handleIncoming(makeMsg({ content: "hello again", messageId: "m3" }));
    expect(fx.defaultPrompt).toHaveBeenCalledWith("hello again");
  });

  it("login capture wins over a pending extension_ui question (ticket requirement)", async () => {
    const fx = makeFixtures({}, runtimeWithSecretPrompt());
    await startLogin(fx);
    // An extension asks a confirm question while the login prompt is parked.
    const request: ExtensionUIRequestView = {
      type: "extension_ui_request",
      id: "q1",
      method: "confirm",
      title: "允许部署?",
      message: "将执行 deploy.sh",
    };
    fx.router.handleEvent(request, fx.defaultRpc);
    await vi.waitFor(() => expect(fx.allText()).toContain("允许部署?"));

    // The next plain message belongs to the LOGIN, not the extension question.
    await fx.router.handleIncoming(makeMsg({ content: "sk-ant-secret", messageId: "m2" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("登录成功"));
    expect(fx.extensionResponses).toHaveLength(0); // extension_ui still parked

    // …and the extension question answers afterwards, once the login is done.
    await fx.router.handleIncoming(makeMsg({ content: "y", messageId: "m3" }));
    await vi.waitFor(() => expect(fx.extensionResponses).toEqual([{ id: "q1", confirmed: true }]));
  });
});

describe("/reload all (issue #55)", () => {
  it("restarts idle rpcs, skips busy ones, and reports both", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "/reload all" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("已重启 1 个空闲进程: 默认"));
    expect(fx.lastReply()).toContain("⚠️ 跳过 1 个忙碌进程: proj-busy(完成后执行 /reload all)");
    expect(fx.defaultRpc.restart).toHaveBeenCalledTimes(1);
    expect(fx.busyRpc.restart).not.toHaveBeenCalled();
  });

  it("plain /reload keeps restarting only the room's own process", async () => {
    const fx = makeFixtures();
    await fx.router.handleIncoming(makeMsg({ content: "/reload" }));
    await vi.waitFor(() => expect(fx.lastReply()).toContain("pi 已重启"));
    expect(fx.defaultRpc.restart).toHaveBeenCalledTimes(1);
    expect(fx.busyRpc.restart).not.toHaveBeenCalled();
  });
});
