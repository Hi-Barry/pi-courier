/**
 * Headless login (issue #55, spec #51 ticket 4) — provider login without
 * leaving Matrix.
 *
 * The admin runs `/login <provider> <oauth|api_key>` in the management room
 * (single-project mode: a DM). An independent ModelRuntime (authPath pointing
 * at pi's standard credential file, shared with every pi subprocess) drives
 * the upstream login flow; the AuthInteraction callbacks are translated into
 * chat messages — auth_url / device_code / progress become display messages,
 * prompts (secret/text/select/manual_code) become questions whose answer is
 * the room's next plain message, and 「取消」 aborts the flow at any time.
 *
 * The courier holds no credentials itself: the runtime writes them straight
 * to <agentDir>/auth.json (file-locked merge write). pi subprocesses only
 * read that file at startup, so after a successful login the caller restarts
 * the IDLE rpcs (restartIdleRpcs in command-map) and tells the room to
 * /reload the busy ones later.
 *
 * Capture priority: while a login flow in a room waits for an answer, plain
 * messages there are captured BEFORE pending extension_ui questions (ticket
 * requirement) — see the router's handleIncoming ordering.
 *
 * Upstream contract verified against
 * node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts (AuthInteraction:
 * prompt rejects = abnormal exit, which is exactly the cancel path) and
 * dist/core/model-runtime.d.ts (login/logout/listCredentials; listCredentials
 * is ASYNC upstream — Promise<readonly CredentialInfo[]>).
 */

import * as path from "node:path";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialInfo,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatReloadAllResult, restartIdleRpcs } from "../rpc/command-map.js";
import type { PiRpc } from "../rpc/pi-rpc.js";

// ===========================================================================
// Provider enumeration (/login with no arguments)
// ===========================================================================

/** One login-able provider with its interactive auth capabilities. */
export interface LoginProviderInfo {
  id: string;
  name: string;
  oauth: boolean;
  apiKey: boolean;
}

/**
 * Enumerate the builtin providers that support an INTERACTIVE login. Presence
 * of `auth.apiKey`/`auth.oauth` alone is not enough — ambient-only providers
 * (env vars, AWS profiles) omit `login` and cannot be logged in from a chat.
 * Sorted by id for a stable listing.
 */
export function listLoginProviders(): LoginProviderInfo[] {
  return builtinProviders()
    .filter((p) => p.auth?.oauth?.login || p.auth?.apiKey?.login)
    .map((p) => ({
      id: p.id,
      name: p.name,
      oauth: Boolean(p.auth?.oauth?.login),
      apiKey: Boolean(p.auth?.apiKey?.login),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Render the /login (no-arg) listing: one line per provider with its methods
 * and a ✅ 已认证(<type>) badge for each stored credential. Pure.
 */
export function formatLoginProviders(
  providers: readonly LoginProviderInfo[],
  credentials: readonly CredentialInfo[] = []
): string {
  if (providers.length === 0) return "没有可登录的 provider。";
  const byProvider = new Map<string, CredentialInfo[]>();
  for (const c of credentials) {
    const list = byProvider.get(c.providerId) ?? [];
    list.push(c);
    byProvider.set(c.providerId, list);
  }
  const lines = providers.map((p) => {
    const methods = [p.oauth ? "oauth" : null, p.apiKey ? "api_key" : null]
      .filter(Boolean)
      .join(" / ");
    const creds = byProvider.get(p.id);
    const badge = creds?.length
      ? ` ✅ 已认证(${creds.map((c) => c.type).join(" + ")})`
      : "";
    return `• ${p.id} — ${p.name}(${methods})${badge}`;
  });
  return `🔐 可登录 provider(${providers.length}):\n${lines.join("\n")}\n\n用 /login <provider> <oauth|api_key> 开始登录。`;
}

/** /auth — the stored credentials, one line each (no secrets, metadata only). */
export function formatCredentials(credentials: readonly CredentialInfo[]): string {
  if (credentials.length === 0) {
    return "💤 暂无已保存凭据(用 /login <provider> <oauth|api_key> 登录)。";
  }
  const lines = credentials.map((c) => `• ${c.providerId} — ${c.type}`);
  return `🔐 已保存凭据 (${credentials.length}):\n${lines.join("\n")}`;
}

// ===========================================================================
// AuthInteraction translation (pure — directly testable)
// ===========================================================================

/** The room message for an upstream login prompt (issue #55). Secret prompts
 *  must warn that the key stays in the room history. */
export function translateAuthPrompt(prompt: AuthPrompt): string {
  switch (prompt.type) {
    case "select": {
      const lines = prompt.options.map((o, i) => {
        const desc = o.description ? ` — ${o.description}` : "";
        return `${i + 1}. ${o.label}${desc}`;
      });
      return `❓ ${prompt.message}\n${lines.join("\n")}\n回复序号选择(发送「取消」放弃)`;
    }
    case "secret":
      return [
        `❓ ${prompt.message}`,
        "直接回复密钥内容。",
        "⚠️ 密钥将留在房间历史,建议用后删除该消息(发送「取消」放弃)",
      ].join("\n");
    case "manual_code":
      return `❓ ${prompt.message}\n把浏览器授权后最终跳转到的完整 URL 直接粘贴回来(发送「取消」放弃)`;
    default: // text
      return `❓ ${prompt.message}\n直接回复内容作为答案(发送「取消」放弃)`;
  }
}

/** The room message for an upstream login event: auth_url / device_code /
 *  progress / info → display-only lines (no answer expected). */
export function translateAuthEvent(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url": {
      const lines = [`🌐 请在浏览器打开以下链接完成授权:\n${event.url}`];
      if (event.instructions) lines.push(event.instructions);
      return lines.join("\n");
    }
    case "device_code": {
      const lines = [
        `🔑 设备码: ${event.userCode}`,
        `请在浏览器打开 ${event.verificationUri} 并输入上述设备码。`,
      ];
      if (event.expiresInSeconds) {
        lines.push(`(有效期约 ${Math.max(1, Math.round(event.expiresInSeconds / 60))} 分钟)`);
      }
      return lines.join("\n");
    }
    case "progress":
      return `⏳ ${event.message}`;
    default: { // info
      const linkLines = (event.links ?? []).map((l) => `🔗 ${l.label ? `${l.label}: ` : ""}${l.url}`);
      return [`ℹ️ ${event.message}`, ...linkLines].join("\n");
    }
  }
}

/** Parsed room message as an answer to a pending login prompt. */
export type LoginAnswer =
  | { kind: "cancel" }
  | { kind: "value"; value: string }
  | { kind: "invalid"; hint: string };

/** Map a room message onto a login prompt's answer (issue #55). Pure.
 *  「取消」 is exact; select maps the 1-based index onto the option ID
 *  (out of range re-asks); every other prompt type takes the whole message. */
export function parseLoginAnswer(prompt: AuthPrompt, text: string): LoginAnswer {
  if (text === "取消") return { kind: "cancel" };
  if (prompt.type === "select") {
    const count = prompt.options.length;
    const index = /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
    if (index >= 1 && index <= count) {
      return { kind: "value", value: prompt.options[index - 1]!.id };
    }
    return { kind: "invalid", hint: `⚠️ 请回复 1 到 ${count} 之间的序号(发送「取消」放弃)` };
  }
  return { kind: "value", value: text };
}

// ===========================================================================
// LoginManager — per-room login flows over an injected runtime
// ===========================================================================

/** Structural seam over ModelRuntime (injected in tests; production binds
 *  the real ModelRuntime at pi's auth file). */
export interface LoginRuntime {
  login(providerId: string, type: "oauth" | "api_key", interaction: AuthInteraction): Promise<Credential>;
  logout(providerId: string): Promise<void>;
  listCredentials(): Promise<readonly CredentialInfo[]>;
}

/** The credential file this module writes: pi's standard auth.json under the
 *  agent dir (PI_CODING_AGENT_DIR respected) — shared with every pi subprocess. */
export function defaultAuthPath(): string {
  return path.join(getAgentDir(), "auth.json");
}

async function defaultRuntimeFactory(authPath: string): Promise<LoginRuntime> {
  // No model-catalog network access needed for login (allowModelNetwork false
  // is upstream's default) and no key validation — we only write credentials.
  return ModelRuntime.create({ authPath });
}

/** Rejection carried out of a cancelled login flow (prompt rejects = upstream
 *  exits abnormally — the documented cancel path). */
export class LoginCancelledError extends Error {
  constructor() {
    super("login cancelled");
    this.name = "LoginCancelledError";
  }
}

export interface LoginManagerDeps {
  /** Room reply (the router's sendReply). */
  sendReply: (chatId: string, transport: string, text: string) => Promise<void>;
  /** Every rpc of this instance (default + started project rpcs): the idle
   *  ones restart after a successful login so the new credential loads. */
  allRpcs: () => PiRpc[];
  /** Router hook: drop per-rpc transient state (queue mirror, pending
   *  extension questions) for each rpc this manager restarts — the new
   *  subprocess knows nothing of the old question ids. */
  onRestarted?: (rpc: PiRpc) => void;
  /** Runtime seam (tests inject a mock; default = real ModelRuntime). */
  runtimeFactory?: (authPath: string) => Promise<LoginRuntime>;
  /** pi credential file (defaults to <agentDir>/auth.json; tests inject a tmp dir). */
  authPath?: string;
}

/** One in-flight login flow, keyed by the room that started it. */
interface PendingLogin {
  chatId: string;
  transport: string;
  providerId: string;
  method: "oauth" | "api_key";
  controller: AbortController;
  /** The prompt currently waiting for a room message (undefined between
   *  prompts — e.g. while polling an OAuth callback server). */
  current?: { prompt: AuthPrompt; submit: (value: string) => void };
  finished: boolean;
}

export class LoginManager {
  private readonly deps: Required<Pick<LoginManagerDeps, "sendReply" | "allRpcs">> &
    LoginManagerDeps;
  private readonly pending = new Map<string, PendingLogin>();
  private runtime?: Promise<LoginRuntime>;

  constructor(deps: LoginManagerDeps) {
    this.deps = deps;
  }

  /** Whether a login flow is active in this room (router capture gate). */
  isPending(chatId: string): boolean {
    return this.pending.has(chatId);
  }

  /** /login with no arguments — the login-able provider list with auth badges. */
  async listProviders(chatId: string, transport: string): Promise<void> {
    let credentials: CredentialInfo[] = [];
    try {
      credentials = [...(await (await this.getRuntime()).listCredentials())];
    } catch {
      // The badge is best-effort — the capability listing still stands.
    }
    await this.deps.sendReply(chatId, transport, formatLoginProviders(listLoginProviders(), credentials));
  }

  /** /login <provider> [oauth|api_key] — start a flow. Gates (admin +
   *  management room) are the router's job; this validates the target. */
  async startLogin(chatId: string, transport: string, providerId: string, method?: string): Promise<void> {
    if (this.pending.has(chatId)) {
      await this.deps.sendReply(chatId, transport, "⚠️ 本房间已有登录流程进行中(发送「取消」中止后再试)。");
      return;
    }
    const provider = listLoginProviders().find((p) => p.id === providerId);
    if (!provider) {
      await this.deps.sendReply(chatId, transport, `❌ 未知 provider: ${providerId}(用 /login 查看可登录列表)`);
      return;
    }
    const supported: Array<"oauth" | "api_key"> = [];
    if (provider.oauth) supported.push("oauth");
    if (provider.apiKey) supported.push("api_key");

    const requested = method?.toLowerCase();
    let chosen: "oauth" | "api_key";
    if (requested === "oauth" || requested === "api_key") {
      chosen = requested;
    } else if (requested) {
      await this.deps.sendReply(chatId, transport, "用法: /login <provider> <oauth|api_key>");
      return;
    } else if (supported.length === 1) {
      chosen = supported[0]!; // unambiguous — pick the only way
    } else {
      await this.deps.sendReply(
        chatId,
        transport,
        `⚠️ ${providerId} 支持多种登录方式(${supported.join(" / ")}),请指定:\n` +
          `/login ${providerId} oauth\n/login ${providerId} api_key`
      );
      return;
    }
    if (!supported.includes(chosen)) {
      await this.deps.sendReply(chatId, transport, `❌ ${providerId} 不支持 ${chosen} 登录(支持: ${supported.join(" / ")})`);
      return;
    }

    const entry: PendingLogin = {
      chatId,
      transport,
      providerId,
      method: chosen,
      controller: new AbortController(),
      finished: false,
    };
    this.pending.set(chatId, entry);
    await this.deps.sendReply(
      chatId,
      transport,
      `🔑 已开始 ${providerId} ${chosen} 登录流程,请按提示操作(任意时刻发送「取消」中止)。`
    );
    // Long-running by design: never block the message pipeline — the flow
    // continues over the capture channel (deliver / cancel).
    void this.run(entry);
  }

  /** Feed a plain room message into the pending flow. Returns true when the
   *  message was consumed. 「取消」 aborts at ANY moment; otherwise only
   *  messages arriving while a prompt is waiting count as the answer — the
   *  room stays usable during long OAuth waits (device polling etc.). */
  async deliver(chatId: string, text: string): Promise<boolean> {
    const entry = this.pending.get(chatId);
    if (!entry || entry.finished) return false;
    if (text === "取消") {
      await this.cancel(chatId);
      return true;
    }
    const current = entry.current;
    if (!current) return false;
    const answer = parseLoginAnswer(current.prompt, text);
    if (answer.kind === "invalid") {
      await this.deps.sendReply(chatId, entry.transport, answer.hint);
      return true;
    }
    if (answer.kind === "cancel") return true; // unreachable: 取消 handled above
    current.submit(answer.value);
    return true;
  }

  /** Abort the room's pending flow (「取消」 or a replacement command). */
  async cancel(chatId: string): Promise<boolean> {
    const entry = this.pending.get(chatId);
    if (!entry || entry.finished) return false;
    entry.finished = true;
    this.pending.delete(chatId);
    // Aborting rejects the parked prompt (LoginCancelledError) → upstream
    // login exits abnormally; run() stays silent for this path.
    entry.controller.abort();
    await this.deps.sendReply(chatId, entry.transport, `🛑 已取消 ${entry.providerId} 的登录流程`);
    return true;
  }

  /** /logout <provider> — delete the stored credential (metadata check first;
   *  logout itself never sees the secret). Running pi processes keep their
   *  in-memory credential until restarted. */
  async logout(chatId: string, transport: string, providerId: string): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      const credentials = await runtime.listCredentials();
      if (!credentials.some((c) => c.providerId === providerId)) {
        await this.deps.sendReply(chatId, transport, `❌ ${providerId} 没有已保存的凭据(用 /auth 查看)`);
        return;
      }
      await runtime.logout(providerId);
      await this.deps.sendReply(
        chatId,
        transport,
        `✅ 已删除 ${providerId} 的凭据。运行中的 pi 进程仍持有旧凭据,空闲后执行 /reload all 使登出生效。`
      );
    } catch (err) {
      await this.deps.sendReply(chatId, transport, `❌ 登出失败: ${(err as Error).message}`);
    }
  }

  /** /auth — which providers are authenticated and how. */
  async authStatus(chatId: string, transport: string): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      await this.deps.sendReply(chatId, transport, formatCredentials([...(await runtime.listCredentials())]));
    } catch (err) {
      await this.deps.sendReply(chatId, transport, `❌ 读取凭据失败: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------

  private async getRuntime(): Promise<LoginRuntime> {
    this.runtime ??= (this.deps.runtimeFactory ?? defaultRuntimeFactory)(
      this.deps.authPath ?? defaultAuthPath()
    );
    return this.runtime;
  }

  /** Drive one login flow to completion: translate the AuthInteraction into
   *  chat round-trips, then restart the idle rpcs on success. */
  private async run(entry: PendingLogin): Promise<void> {
    const { chatId, transport, providerId, method } = entry;
    const interaction: AuthInteraction = {
      signal: entry.controller.signal,
      prompt: (p) => this.promptUser(entry, p),
      notify: (e) => {
        void this.deps.sendReply(chatId, transport, translateAuthEvent(e));
      },
    };
    try {
      const runtime = await this.getRuntime();
      await runtime.login(providerId, method, interaction);
      if (entry.controller.signal.aborted) return; // cancelled mid-write
      entry.finished = true;
      this.drop(entry);
      const lines = [`✅ ${providerId} 登录成功,凭据已写入 ${this.deps.authPath ?? defaultAuthPath()}`];
      try {
        // pi subprocesses read the credential file once at startup — restart
        // the idle ones now, tell the room about the busy ones (issue #55).
        lines.push(formatReloadAllResult(await restartIdleRpcs(this.deps.allRpcs(), this.deps.onRestarted)));
      } catch {
        // Restart trouble must never fail the (already persisted) login reply.
      }
      await this.deps.sendReply(chatId, transport, lines.join("\n"));
    } catch (err) {
      entry.finished = true;
      this.drop(entry);
      if (err instanceof LoginCancelledError || entry.controller.signal.aborted) return;
      await this.deps.sendReply(chatId, transport, `❌ ${providerId} 登录失败: ${(err as Error).message}`);
    }
  }

  /** Remove this flow's pending entry — and only its own: after a quick
   *  cancel + re-login in the same room, a still-draining old flow must not
   *  evict the NEW entry (the map is keyed by chat). */
  private drop(entry: PendingLogin): void {
    if (this.pending.get(entry.chatId) === entry) this.pending.delete(entry.chatId);
  }

  /** Park a prompt: post the question, resolve with the room's next answer,
   *  reject on abort (upstream treats a rejected prompt as abnormal exit —
   *  the documented cancel path). */
  private async promptUser(entry: PendingLogin, prompt: AuthPrompt): Promise<string> {
    await this.deps.sendReply(entry.chatId, entry.transport, translateAuthPrompt(prompt));
    return new Promise<string>((resolve, reject) => {
      if (entry.controller.signal.aborted) {
        reject(new LoginCancelledError());
        return;
      }
      const onAbort = () => {
        entry.current = undefined;
        reject(new LoginCancelledError());
      };
      entry.controller.signal.addEventListener("abort", onAbort, { once: true });
      entry.current = {
        prompt,
        submit: (value) => {
          entry.controller.signal.removeEventListener("abort", onAbort);
          entry.current = undefined;
          resolve(value);
        },
      };
    });
  }
}
