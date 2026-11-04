/**
 * Headless login (issue #55, spec #51 ticket 4).
 *
 * Pure parts: provider enumeration/formatting, AuthInteraction → chat
 * translation, answer parsing, restart-idle-rpcs summary. Manager parts:
 * LoginManager over an INJECTED mock runtime (never the real ModelRuntime —
 * tests must not touch ~/.pi; authPath points at a throwaway tmp dir).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthInteraction, AuthPrompt, Credential, CredentialInfo } from "@earendil-works/pi-ai";
import {
  formatCredentials,
  formatLoginProviders,
  LoginCancelledError,
  type LoginProviderInfo,
  type LoginRuntime,
  listLoginProviders,
  LoginManager,
  parseLoginAnswer,
  translateAuthEvent,
  translateAuthPrompt,
} from "../src/auth/headless-login";
import { formatReloadAllResult, restartIdleRpcs } from "../src/rpc/command-map";
import type { PiRpc } from "../src/rpc/pi-rpc";

// --- pure: provider enumeration + formatting ---------------------------------

describe("provider enumeration + formatting (issue #55)", () => {
  it("listLoginProviders only lists providers with an interactive login, sorted by id", () => {
    const list = listLoginProviders();
    expect(list.length).toBeGreaterThan(0);
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.id >= list[i - 1]!.id).toBe(true);
    }
    for (const p of list) {
      expect(p.oauth || p.apiKey).toBe(true); // no ambient-only dead entries
      expect(p.name.length).toBeGreaterThan(0);
    }
    expect(list.find((p) => p.id === "anthropic")).toMatchObject({
      id: "anthropic",
      oauth: true,
      apiKey: true,
    });
  });

  const providers: LoginProviderInfo[] = [
    { id: "anthropic", name: "Anthropic", oauth: true, apiKey: true },
    { id: "openai", name: "OpenAI", oauth: false, apiKey: true },
  ];

  it("formatLoginProviders renders methods and 已认证 badges", () => {
    const text = formatLoginProviders(providers, [{ providerId: "anthropic", type: "oauth" } as CredentialInfo]);
    expect(text).toContain("可登录 provider(2)");
    expect(text).toContain("• anthropic — Anthropic(oauth / api_key) ✅ 已认证(oauth)");
    expect(text).toContain("• openai — OpenAI(api_key)"); // no badge
    expect(text).toContain("/login <provider> <oauth|api_key>");
  });

  it("formatLoginProviders handles multiple credentials and the empty list", () => {
    const both = formatLoginProviders([providers[0]!], [
      { providerId: "anthropic", type: "oauth" } as CredentialInfo,
      { providerId: "anthropic", type: "api_key" } as CredentialInfo,
    ]);
    expect(both).toContain("✅ 已认证(oauth + api_key)");
    expect(formatLoginProviders([], [])).toBe("没有可登录的 provider。");
  });

  it("formatCredentials lists stored credentials or the empty hint", () => {
    expect(formatCredentials([])).toContain("暂无已保存凭据");
    const text = formatCredentials([
      { providerId: "anthropic", type: "oauth" } as CredentialInfo,
      { providerId: "openai", type: "api_key" } as CredentialInfo,
    ]);
    expect(text).toContain("已保存凭据 (2)");
    expect(text).toContain("• anthropic — oauth");
    expect(text).toContain("• openai — api_key");
  });
});

// --- pure: AuthInteraction translation ---------------------------------------

describe("AuthInteraction translation (issue #55)", () => {
  it("select prompts become a numbered list with descriptions", () => {
    const prompt: AuthPrompt = {
      type: "select",
      message: "选择订阅",
      options: [
        { id: "pro", label: "Pro", description: "每月 20 美元" },
        { id: "max", label: "Max" },
      ],
    };
    const text = translateAuthPrompt(prompt);
    expect(text).toContain("❓ 选择订阅");
    expect(text).toContain("1. Pro — 每月 20 美元");
    expect(text).toContain("2. Max");
    expect(text).toContain("回复序号选择(发送「取消」放弃)");
  });

  it("secret prompts carry the room-history warning; manual_code asks for the pasted URL", () => {
    const secret = translateAuthPrompt({ type: "secret", message: "粘贴 API key" });
    expect(secret).toContain("❓ 粘贴 API key");
    expect(secret).toContain("房间历史");
    expect(secret).toContain("删除该消息");
    expect(secret).toContain("「取消」");

    const manual = translateAuthPrompt({ type: "manual_code", message: "完成授权后粘贴 URL" });
    expect(manual).toContain("完整 URL");
    expect(manual).toContain("「取消」");

    const text = translateAuthPrompt({ type: "text", message: "起个名字" });
    expect(text).toContain("直接回复内容作为答案");
  });

  it("auth_url / device_code / progress / info events map to display messages", () => {
    expect(
      translateAuthEvent({ type: "auth_url", url: "https://claude.ai/oauth/authorize", instructions: "点击 Authorize" })
    ).toBe("🌐 请在浏览器打开以下链接完成授权:\nhttps://claude.ai/oauth/authorize\n点击 Authorize");

    const device = translateAuthEvent({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://claude.ai/device",
      expiresInSeconds: 300,
    });
    expect(device).toContain("🔑 设备码: ABCD-1234");
    expect(device).toContain("https://claude.ai/device");
    expect(device).toContain("5 分钟");

    expect(translateAuthEvent({ type: "progress", message: "等待授权…" })).toBe("⏳ 等待授权…");
    const info = translateAuthEvent({
      type: "info",
      message: "需要先登录",
      links: [{ url: "https://example.com", label: "帮助" }],
    });
    expect(info).toContain("ℹ️ 需要先登录");
    expect(info).toContain("🔗 帮助: https://example.com");
  });

  it("parseLoginAnswer: 取消 is exact, select maps 1-based onto option ids, others take the whole message", () => {
    const select: AuthPrompt = {
      type: "select",
      message: "选",
      options: [{ id: "alpha", label: "A" }, { id: "beta", label: "B" }],
    };
    expect(parseLoginAnswer(select, "取消")).toEqual({ kind: "cancel" });
    expect(parseLoginAnswer(select, "1")).toEqual({ kind: "value", value: "alpha" });
    expect(parseLoginAnswer(select, "2")).toEqual({ kind: "value", value: "beta" });
    expect(parseLoginAnswer(select, "3").kind).toBe("invalid");
    expect(parseLoginAnswer(select, "abc").kind).toBe("invalid");

    expect(parseLoginAnswer({ type: "secret", message: "k" }, "sk-ant-1")).toEqual({ kind: "value", value: "sk-ant-1" });
    expect(parseLoginAnswer({ type: "text", message: "t" }, "取消部署").kind).toBe("value");
    expect(parseLoginAnswer({ type: "manual_code", message: "m" }, "http://localhost:1455/callback?code=x")).toEqual({
      kind: "value",
      value: "http://localhost:1455/callback?code=x",
    });
  });
});

// --- pure: restartIdleRpcs + summary ------------------------------------------

function makeRpc(label: string | undefined, state: "idle" | "streaming" | "unreachable"): PiRpc {
  const rpc: PiRpc = {
    label,
    getState:
      state === "unreachable"
        ? vi.fn().mockRejectedValue(new Error("pi RPC not connected"))
        : vi.fn().mockResolvedValue({ isStreaming: state === "streaming", model: { id: "m" } }),
    restart: vi.fn().mockResolvedValue(undefined),
    requireClient: () => rpc,
  } as unknown as PiRpc;
  return rpc;
}

describe("restartIdleRpcs (issue #55)", () => {
  it("restarts idle, skips busy and unqueryable, and renders the summary", async () => {
    const idle = makeRpc(undefined, "idle");
    const busy = makeRpc("proj-x", "streaming");
    const dead = makeRpc("lazy-proj", "unreachable");
    const result = await restartIdleRpcs([idle, busy, dead]);
    expect(result).toEqual({ restarted: ["默认"], busy: ["proj-x"], skipped: ["lazy-proj"] });
    expect(idle.restart).toHaveBeenCalledTimes(1);
    expect(busy.restart).not.toHaveBeenCalled();
    expect(dead.restart).not.toHaveBeenCalled();

    const text = formatReloadAllResult(result);
    expect(text).toContain("✅ 已重启 1 个空闲进程: 默认");
    expect(text).toContain("⚠️ 跳过 1 个忙碌进程: proj-x(完成后执行 /reload all)");
    expect(text).toContain("lazy-proj");
  });

  it("the all-idle and all-busy summaries read sanely", async () => {
    const a = makeRpc(undefined, "idle");
    const b = makeRpc("p", "idle");
    expect(formatReloadAllResult(await restartIdleRpcs([a, b]))).toBe("✅ 已重启 2 个空闲进程: 默认、p");
    expect(formatReloadAllResult(await restartIdleRpcs([makeRpc(undefined, "streaming")]))).toContain(
      "💤 没有需要重启的空闲进程"
    );
  });
});

// --- LoginManager over an injected mock runtime --------------------------------

function makeRuntime(overrides: Partial<LoginRuntime> = {}): LoginRuntime {
  return {
    login: vi.fn(async () => ({ type: "api_key", key: "written" }) as Credential),
    logout: vi.fn(async () => {}),
    listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "oauth" }] as CredentialInfo[]),
    ...overrides,
  };
}

function makeManager(runtime: LoginRuntime, allRpcs: PiRpc[] = []) {
  const replies: string[] = [];
  const authPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p55-login-")), "auth.json");
  const manager = new LoginManager({
    sendReply: async (_chatId, _transport, text) => {
      replies.push(text);
    },
    allRpcs: () => allRpcs,
    runtimeFactory: async () => runtime,
    authPath,
  });
  /** Wait until the start acknowledgement (and everything before it) landed. */
  const flush = () => vi.waitFor(() => expect(replies.join("\n")).toContain("登录流程,请按提示操作"));
  return { replies, manager, flush, authPath };
}

const CHAT = "!dm:server";
/** 流程发起者(sec-login-sender-guard):startLogin 绑定的身份,后续
 *  deliver/cancel 只认 TA;他人用 MALLORY 对照。 */
const STARTER = "@barry:server";
const MALLORY = "@mallory:server";

describe("LoginManager (issue #55)", () => {
  it("startLogin validates provider and method before starting anything", async () => {
    const runtime = makeRuntime();
    const { replies, manager } = makeManager(runtime);
    await manager.startLogin(CHAT, "matrix", "nope", STARTER);
    expect(replies.at(-1)).toContain("❌ 未知 provider: nope");

    await manager.startLogin(CHAT, "matrix", "zai", STARTER, "oauth"); // zai has no oauth login (pi 1.0: openai gained ChatGPT sign-in, so it now has oauth)
    expect(replies.at(-1)).toContain("不支持 oauth 登录");

    await manager.startLogin(CHAT, "matrix", "nope", STARTER, "bogus");
    expect(replies.at(-1)).toContain("❌ 未知 provider: nope");

    // Unambiguous provider: the only supported method is picked automatically.
    await manager.startLogin(CHAT, "matrix", "zai", STARTER);
    await vi.waitFor(() =>
      expect((runtime.login as ReturnType<typeof vi.fn>).mock.calls[0]?.slice(0, 2)).toEqual(["zai", "api_key"])
    );
    await manager.cancel(CHAT, STARTER);

    // Ambiguous provider without a method: ask which one.
    await manager.startLogin(CHAT, "matrix", "anthropic", STARTER);
    expect(replies.at(-1)).toContain("支持多种登录方式(oauth / api_key)");
    expect((runtime.login as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // nothing new started
  });

  it("a second /login in the same room is rejected while one is in flight", async () => {
    const { manager, replies, flush } = makeManager(
      makeRuntime({
        login: async (_p, _t, interaction: AuthInteraction) => {
          await interaction.prompt({ type: "secret", message: "key?" });
          return { type: "api_key", key: "k" } as Credential;
        },
      })
    );
    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await manager.startLogin(CHAT, "matrix", "openai", STARTER, "api_key");
    expect(replies.at(-1)).toContain("已有登录流程进行中");
    await manager.cancel(CHAT, STARTER);
  });

  it("api_key flow: secret question → pasted key → success + idle restart summary", async () => {
    const idle = makeRpc(undefined, "idle");
    const busy = makeRpc("proj-x", "streaming");
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        await interaction.prompt({ type: "secret", message: "粘贴你的 Anthropic API key" });
        return { type: "api_key", key: "sk-written" } as Credential;
      }),
    });
    const { manager, replies, flush, authPath } = makeManager(runtime, [idle, busy]);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("粘贴你的 Anthropic API key"));
    expect(replies.join("\n")).toContain("房间历史"); // the secret warning is present

    expect(await manager.deliver(CHAT, STARTER, "sk-ant-test")).toBe(true);

    await vi.waitFor(() => expect(replies.at(-1)).toContain("登录成功"));
    const summary = replies.at(-1)!;
    expect(summary).toContain(`凭据已写入 ${authPath}`); // injected path, never ~/.pi
    expect(summary).toContain("✅ 已重启 1 个空闲进程: 默认");
    expect(summary).toContain("⚠️ 跳过 1 个忙碌进程: proj-x(完成后执行 /reload all)");
    expect(idle.restart).toHaveBeenCalledTimes(1);
    expect(busy.restart).not.toHaveBeenCalled();
    expect(manager.isPending(CHAT)).toBe(false); // flow closed
  });

  it("cancel: 「取消」 aborts the parked prompt, no credential is written", async () => {
    let promptError: unknown;
    const login = vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
      try {
        await interaction.prompt({ type: "secret", message: "key?" });
      } catch (err) {
        promptError = err;
        throw err;
      }
      throw new Error("should not reach here");
    });
    const runtime = makeRuntime({ login });
    const idle = makeRpc(undefined, "idle");
    const { manager, replies, flush } = makeManager(runtime, [idle]);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("key?")); // prompt parked
    expect(await manager.deliver(CHAT, STARTER, "取消")).toBe(true);
    expect(replies.at(-1)).toContain("🛑 已取消 anthropic 的登录流程");

    await vi.waitFor(() => expect(promptError).toBeInstanceOf(LoginCancelledError));
    expect(replies.join("\n")).not.toContain("登录成功");
    expect(idle.restart).not.toHaveBeenCalled();
    expect(manager.isPending(CHAT)).toBe(false);
    // After the cancel, plain messages are no longer captured.
    expect(await manager.deliver(CHAT, STARTER, "hello")).toBe(false);
  });

  it("select prompts submit option ids; invalid input re-asks without dequeuing", async () => {
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        const plan = await interaction.prompt({
          type: "select",
          message: "选择订阅",
          options: [{ id: "pro", label: "Pro" }, { id: "max", label: "Max" }],
        });
        expect(plan).toBe("max");
        return { type: "oauth", refresh: "r", access: "a", expires: 1 } as Credential;
      }),
    });
    const { manager, replies, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "oauth");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("选择订阅"));

    expect(await manager.deliver(CHAT, STARTER, "9")).toBe(true);
    expect(replies.at(-1)).toContain("请回复 1 到 2 之间的序号");
    expect(manager.isPending(CHAT)).toBe(true);

    expect(await manager.deliver(CHAT, STARTER, "2")).toBe(true);
    await vi.waitFor(() => expect(replies.join("\n")).toContain("登录成功"));
  });

  it("messages between prompts are NOT consumed (room stays usable during OAuth waits)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        await gate;
        await interaction.notify({ type: "progress", message: "等待授权回调…" });
        await interaction.prompt({ type: "secret", message: "key?" });
        return { type: "api_key", key: "k" } as Credential;
      }),
    });
    const { manager, replies, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    expect(manager.isPending(CHAT)).toBe(true);

    // No prompt is waiting yet — the message must fall through untouched.
    expect(await manager.deliver(CHAT, STARTER, "a normal message")).toBe(false);

    release();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("⏳ 等待授权回调…"));
    await vi.waitFor(() => expect(replies.join("\n")).toContain("key?"));
    // The prompt is up now — the next message IS the answer.
    expect(await manager.deliver(CHAT, STARTER, "sk-late")).toBe(true);
    await vi.waitFor(() => expect(manager.isPending(CHAT)).toBe(false));
  });

  it("logout requires an existing credential and reports deletion", async () => {
    const runtime = makeRuntime();
    const { manager, replies } = makeManager(runtime);
    await manager.logout(CHAT, "matrix", "openai");
    expect(replies.at(-1)).toContain("openai 没有已保存的凭据");
    expect(runtime.logout).not.toHaveBeenCalled();

    await manager.logout(CHAT, "matrix", "anthropic");
    expect(runtime.logout).toHaveBeenCalledWith("anthropic");
    expect(replies.at(-1)).toContain("✅ 已删除 anthropic 的凭据");
    expect(replies.at(-1)).toContain("/reload all");
  });

  it("logout failures surface in the room", async () => {
    const runtime = makeRuntime({
      logout: vi.fn(async () => {
        throw new Error("disk on fire");
      }),
    });
    const { manager, replies } = makeManager(runtime);
    await manager.logout(CHAT, "matrix", "anthropic");
    expect(replies.at(-1)).toContain("❌ 登出失败: disk on fire");
  });

  it("listProviders and authStatus render through the runtime", async () => {
    const runtime = makeRuntime();
    const { manager, replies } = makeManager(runtime);
    await manager.listProviders(CHAT, "matrix");
    expect(replies.at(-1)).toContain("anthropic");
    expect(replies.at(-1)).toContain("✅ 已认证(oauth)");

    await manager.authStatus(CHAT, "matrix");
    expect(replies.at(-1)).toContain("• anthropic — oauth");
  });

  it("runtime failures on /auth and login start are reported, not thrown", async () => {
    const runtime = makeRuntime({
      listCredentials: vi.fn(async () => {
        throw new Error("auth.json unreadable");
      }),
      login: vi.fn(async () => {
        throw new Error("flow exploded");
      }),
    });
    const { manager, replies } = makeManager(runtime);
    await manager.authStatus(CHAT, "matrix");
    expect(replies.at(-1)).toContain("❌ 读取凭据失败: auth.json unreadable");

    await manager.startLogin(CHAT, "matrix", "openai", STARTER, "api_key");
    await vi.waitFor(() => expect(replies.at(-1)).toContain("❌ openai 登录失败: flow exploded"));
    expect(manager.isPending(CHAT)).toBe(false);
  });
});

// --- sender guard (sec-login-sender-guard) -------------------------------------
//
// 管理房里非 admin 的受信成员会被邀入(admin-commands 配对成功即发
// managementRoomInvite effect),/login 等待 prompt(尤其 secret)时,
// 只有流程发起者本人可以作答/取消 —— 他人的消息一律不消费、原样落穿。

describe("LoginManager sender guard (sec-login-sender-guard)", () => {
  it("a non-starter's answer is not consumed and never reaches the flow; the starter's own answer still lands", async () => {
    let submitted: string | undefined;
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        submitted = await interaction.prompt({ type: "secret", message: "key?" });
        return { type: "api_key", key: submitted } as Credential;
      }),
    });
    const { manager, replies, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("key?"));

    // 他人在 prompt 等待中贴 key:不消费,prompt 不被 resolve,流程仍挂起。
    expect(await manager.deliver(CHAT, MALLORY, "sk-mallory-injected")).toBe(false);
    expect(manager.isPending(CHAT)).toBe(true);
    expect(submitted).toBeUndefined(); // 注入值从未进入流程

    // 同一条消息路径,发起者本人作答照常成功 —— 且答案是他自己的。
    expect(await manager.deliver(CHAT, STARTER, "sk-ant-owner")).toBe(true);
    await vi.waitFor(() => expect(replies.at(-1)).toContain("登录成功"));
    expect(submitted).toBe("sk-ant-owner");
    expect(manager.isPending(CHAT)).toBe(false);
  });

  it("a non-starter's 「取消」 does not abort the flow; the starter can still cancel", async () => {
    let promptError: unknown;
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        try {
          await interaction.prompt({ type: "secret", message: "key?" });
        } catch (err) {
          promptError = err;
          throw err;
        }
        throw new Error("should not reach here");
      }),
    });
    const { manager, replies, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("key?"));

    // 他人的取消词:不消费,流程原样保留,无取消回执。
    expect(await manager.deliver(CHAT, MALLORY, "取消")).toBe(false);
    expect(manager.isPending(CHAT)).toBe(true);
    expect(replies.at(-1)).not.toContain("已取消");
    expect(promptError).toBeUndefined(); // prompt 仍挂着

    // 发起者本人取消仍然生效。
    expect(await manager.deliver(CHAT, STARTER, "取消")).toBe(true);
    expect(replies.at(-1)).toContain("🛑 已取消 anthropic 的登录流程");
    await vi.waitFor(() => expect(promptError).toBeInstanceOf(LoginCancelledError));
    expect(manager.isPending(CHAT)).toBe(false);
  });

  it("cancel(chatId, sender) rejects a non-starter directly (defense in depth)", async () => {
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        await interaction.prompt({ type: "secret", message: "key?" });
        return { type: "api_key", key: "k" } as Credential;
      }),
    });
    const { manager, replies, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    await vi.waitFor(() => expect(replies.join("\n")).toContain("key?"));

    expect(await manager.cancel(CHAT, MALLORY)).toBe(false);
    expect(manager.isPending(CHAT)).toBe(true);
    expect(replies.at(-1)).not.toContain("已取消");

    expect(await manager.cancel(CHAT, STARTER)).toBe(true);
    expect(replies.at(-1)).toContain("🛑 已取消 anthropic 的登录流程");
  });

  it("between prompts a non-starter's plain message is untouched, same as before (no warn-worthy consumption)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = makeRuntime({
      login: vi.fn(async (_p: string, _t: string, interaction: AuthInteraction) => {
        await gate;
        await interaction.prompt({ type: "secret", message: "key?" });
        return { type: "api_key", key: "k" } as Credential;
      }),
    });
    const { manager, flush } = makeManager(runtime);

    void manager.startLogin(CHAT, "matrix", "anthropic", STARTER, "api_key");
    await flush();
    // OAuth 轮询窗口(无 prompt 等待):他人与发起者的消息都照旧落穿。
    expect(await manager.deliver(CHAT, MALLORY, "chat chatter")).toBe(false);
    expect(await manager.deliver(CHAT, STARTER, "chat chatter")).toBe(false);
    release();
    await vi.waitFor(() => expect(manager.isPending(CHAT)).toBe(true));
    await manager.cancel(CHAT, STARTER);
  });
});
