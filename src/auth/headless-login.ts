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
import { t } from "../i18n/index.js";
import { isCancelInput } from "../i18n/parse.js";
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
  if (providers.length === 0) return t("login.noProviders");
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
      ? ` ${t("login.authenticated", { types: creds.map((c) => c.type).join(" + ") })}`
      : "";
    return `• ${p.id} — ${p.name}(${methods})${badge}`;
  });
  return t("login.providersList", { count: providers.length, lines: lines.join("\n") });
}

/** /auth — the stored credentials, one line each (no secrets, metadata only). */
export function formatCredentials(credentials: readonly CredentialInfo[]): string {
  if (credentials.length === 0) {
    return t("login.noCredentials");
  }
  const lines = credentials.map((c) => `• ${c.providerId} — ${c.type}`);
  return t("login.credentialsList", { count: credentials.length, lines: lines.join("\n") });
}

// ===========================================================================
// AuthInteraction translation (pure — directly testable)
// ===========================================================================

/** The room message for an upstream login prompt (issue #55). Secret prompts
 *  must warn that the key stays in the room history. The select/text how-to
 *  lines reuse the extension-question phrasings — same protocol, same wording. */
export function translateAuthPrompt(prompt: AuthPrompt): string {
  switch (prompt.type) {
    case "select": {
      const lines = prompt.options.map((o, i) => {
        const desc = o.description ? ` — ${o.description}` : "";
        return `${i + 1}. ${o.label}${desc}`;
      });
      return `❓ ${prompt.message}\n${lines.join("\n")}\n${t("xq.select.how")}`;
    }
    case "secret":
      return [
        `❓ ${prompt.message}`,
        t("login.secret.line2"),
        t("login.secret.line3"),
      ].join("\n");
    case "manual_code":
      return `❓ ${prompt.message}\n${t("login.manualCode.how")}`;
    default: // text
      return `❓ ${prompt.message}\n${t("xq.input.how")}`;
  }
}

/** The room message for an upstream login event: auth_url / device_code /
 *  progress / info → display-only lines (no answer expected). */
export function translateAuthEvent(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url": {
      const lines = [t("login.authUrl", { url: event.url })];
      if (event.instructions) lines.push(event.instructions);
      return lines.join("\n");
    }
    case "device_code": {
      const lines = [
        t("login.deviceCode", { code: event.userCode }),
        t("login.deviceCodeOpen", { uri: event.verificationUri }),
      ];
      if (event.expiresInSeconds) {
        lines.push(t("login.expiresMinutes", { minutes: Math.max(1, Math.round(event.expiresInSeconds / 60)) }));
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
 *  The cancel word (取消/cancel, any case, trimmed); select maps the 1-based
 *  index onto the option ID (out of range re-asks); every other prompt type
 *  takes the whole message. */
export function parseLoginAnswer(prompt: AuthPrompt, text: string): LoginAnswer {
  if (isCancelInput(text)) return { kind: "cancel" };
  if (prompt.type === "select") {
    const count = prompt.options.length;
    const index = /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
    if (index >= 1 && index <= count) {
      return { kind: "value", value: prompt.options[index - 1]!.id };
    }
    return { kind: "invalid", hint: t("xq.select.invalid", { max: count }) };
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

/**
 * Lazy loader for @earendil-works/pi-coding-agent. The package is a runtime
 * poison on Node <22.19 since pi 1.0 (`fs.globSync` import dies at module
 * evaluation, killing this whole process) — so it must never appear in a
 * static value import here. The engine gate in pi-rpc runs before any RPC
 * spawn; this loader keeps the login path equally safe.
 */
async function loadCodingAgent(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  return import("@earendil-works/pi-coding-agent");
}

/** The credential file this module writes: pi's standard auth.json under the
 *  agent dir (PI_CODING_AGENT_DIR respected) — shared with every pi subprocess. */
export async function defaultAuthPath(): Promise<string> {
  return path.join((await loadCodingAgent()).getAgentDir(), "auth.json");
}

async function defaultRuntimeFactory(authPath: string): Promise<LoginRuntime> {
  // No model-catalog network access needed for login (allowModelNetwork false
  // is upstream's default) and no key validation — we only write credentials.
  const { ModelRuntime } = await loadCodingAgent();
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
   *  ones restart after a successful login so the new credential loads.
   *  瞬态状态失效由 rpc 自身的重启生命周期广播接管(spec #72 票6/C5),
   *  本管理器不再携带失效回调。 */
  allRpcs: () => PiRpc[];
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
      await this.deps.sendReply(chatId, transport, t("login.pendingInRoom"));
      return;
    }
    const provider = listLoginProviders().find((p) => p.id === providerId);
    if (!provider) {
      await this.deps.sendReply(chatId, transport, t("login.unknownProvider", { id: providerId }));
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
      await this.deps.sendReply(chatId, transport, t("login.usage"));
      return;
    } else if (supported.length === 1) {
      chosen = supported[0]!; // unambiguous — pick the only way
    } else {
      await this.deps.sendReply(chatId, transport, t("login.chooseMethod", { id: providerId, methods: supported.join(" / ") }));
      return;
    }
    if (!supported.includes(chosen)) {
      await this.deps.sendReply(chatId, transport, t("login.unsupportedMethod", { id: providerId, method: chosen, methods: supported.join(" / ") }));
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
    await this.deps.sendReply(chatId, transport, t("login.started", { id: providerId, method: chosen }));
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
    if (isCancelInput(text)) {
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
    if (answer.kind === "cancel") return true; // unreachable: cancel handled above
    current.submit(answer.value);
    return true;
  }

  /** Abort the room's pending flow (cancel word or a replacement command). */
  async cancel(chatId: string): Promise<boolean> {
    const entry = this.pending.get(chatId);
    if (!entry || entry.finished) return false;
    entry.finished = true;
    this.pending.delete(chatId);
    // Aborting rejects the parked prompt (LoginCancelledError) → upstream
    // login exits abnormally; run() stays silent for this path.
    entry.controller.abort();
    await this.deps.sendReply(chatId, entry.transport, t("login.cancelled", { id: entry.providerId }));
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
        await this.deps.sendReply(chatId, transport, t("login.noStoredCred", { id: providerId }));
        return;
      }
      await runtime.logout(providerId);
      await this.deps.sendReply(chatId, transport, t("login.logoutOk", { id: providerId }));
    } catch (err) {
      await this.deps.sendReply(chatId, transport, t("login.logoutFailed", { message: (err as Error).message }));
    }
  }

  /** /auth — which providers are authenticated and how. */
  async authStatus(chatId: string, transport: string): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      await this.deps.sendReply(chatId, transport, formatCredentials([...(await runtime.listCredentials())]));
    } catch (err) {
      await this.deps.sendReply(chatId, transport, t("login.readFailed", { message: (err as Error).message }));
    }
  }

  // -------------------------------------------------------------------------

  private async getRuntime(): Promise<LoginRuntime> {
    this.runtime ??= (this.deps.runtimeFactory ?? defaultRuntimeFactory)(
      this.deps.authPath ?? (await defaultAuthPath())
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
      const lines = [t("login.success", { id: providerId, path: this.deps.authPath ?? (await defaultAuthPath()) })];
      try {
        // pi subprocesses read the credential file once at startup — restart
        // the idle ones now, tell the room about the busy ones (issue #55).
        lines.push(formatReloadAllResult(await restartIdleRpcs(this.deps.allRpcs())));
      } catch {
        // Restart trouble must never fail the (already persisted) login reply.
      }
      await this.deps.sendReply(chatId, transport, lines.join("\n"));
    } catch (err) {
      entry.finished = true;
      this.drop(entry);
      if (err instanceof LoginCancelledError || entry.controller.signal.aborted) return;
      await this.deps.sendReply(chatId, transport, t("login.failed", { id: providerId, message: (err as Error).message }));
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
