/**
 * Interactive first-run setup wizard.
 *
 * Usage: node dist/standalone.js --setup
 *
 * Walks through: Matrix homeserver → bot login (or pasted token) → trusted
 * admin user → E2EE toggle, then writes ~/.pi/pi-courier.json.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import {
  attachmentsDirectory,
  attachmentsMaxMb,
  effectiveInstanceName,
  effectiveWorkdir,
  loadConfig,
  nativeMxid,
  saveConfig,
} from "./config.js";
import { detectSystemLanguage } from "./i18n/detect.js";
import type { Locale } from "./i18n/index.js";
import { setLocale, t } from "./i18n/index.js";
import type { MsgBridgeConfig } from "./types.js";

/**
 * Input abstraction that works in both modes:
 *  - TTY: interactive question() (echoes prompt, reads one line at a time)
 *  - piped/closed stdin: pre-read all lines, consume in order (no line loss,
 *    which readline.question suffers from when input is buffered)
 * Returns { ask, close } — close() releases stdin listeners so the process
 * can exit naturally after setup finishes.
 */
function createPrompter(): {
  ask: (prompt: string, opts?: { silent?: boolean }) => Promise<string>;
  close: () => void;
} {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    // Each ask registers a `close` listener; the wizard makes a handful of
    // asks, which trips the default 10-listener warning. It's harmless (each
    // is `once`, freed at process exit), so lift the cap.
    rl.setMaxListeners(0);
    return {
      ask: (prompt, opts) =>
        new Promise((resolve) => {
          let done = false;
          const finish = (answer: string): void => {
            if (!done) {
              done = true;
              resolve(answer);
            }
          };
          if (opts?.silent) {
            // Hidden password input (Node's documented _writeToOutput pattern):
            // let the prompt through, render typed characters as stars.
            const output = rl as unknown as { _writeToOutput: (s: string) => void };
            const origWrite = output._writeToOutput;
            let stars = 0;
            output._writeToOutput = (str: string) => {
              if (str === prompt) {
                origWrite.call(rl, prompt); // show the prompt itself
              } else if (str === "\x7f" || str === "\b") {
                if (stars > 0) {
                  origWrite.call(rl, "\b \b"); // backspace: erase one star
                  stars--;
                }
              } else if (/^[\x20-\x7e\u00a0-\uffff]$/.test(str)) {
                origWrite.call(rl, "*"); // printable input -> star
                stars++;
              }
              // control sequences are swallowed (no echo, no cursor noise)
            };
            rl.question(prompt, (answer) => {
              output._writeToOutput = origWrite;
              origWrite.call(rl, "\n");
              finish(answer);
            });
          } else {
            rl.question(prompt, finish);
          }
          rl.once("close", () => finish(""));
        }),
      close: () => {
        rl.close();
      },
    };
  }

  // Piped mode: read everything up front, then consume line by line
  let data = "";
  stdin.setEncoding("utf-8");
  stdin.on("data", (chunk) => {
    data += chunk as string;
  });
  const lines: string[] = [];
  stdin.on("end", () => {
    lines.push(...data.split("\n"));
  });
  return {
    ask: async (prompt: string) => {
      process.stdout.write(prompt);
      await new Promise((resolve) => {
        if (lines.length > 0 || data.length > 0) resolve(undefined);
        else stdin.once("end", () => resolve(undefined));
      });
      return lines.shift()?.trim() ?? "";
    },
    close: () => {
      stdin.removeAllListeners("data");
      stdin.removeAllListeners("end");
    },
  };
}

async function matrixLogin(
  homeserver: string,
  username: string,
  password: string,
  deviceId?: string
): Promise<{ accessToken: string; userId: string }> {
  const url = `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/login`;
  const body: Record<string, unknown> = {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
  };
  if (deviceId) {
    // 固定 device_id:同一 bot 账号重跑 setup 时复用同一个设备身份,
    // 避免换 token 后设备变化导致 M_BAD_JSON / 历史密钥丢失。
    body.device_id = deviceId;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(t("setup.token.loginFailed", { status: res.status, body: body.slice(0, 300) }));
  }
  const data = (await res.json()) as { access_token?: string; user_id?: string };
  if (!data.access_token) throw new Error(t("setup.token.missingAccessToken"));
  return { accessToken: data.access_token, userId: data.user_id ?? "" };
}

async function matrixWhoami(homeserver: string, accessToken: string): Promise<string> {
  const url = `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(t("setup.token.whoamiFailed", { status: res.status }));
  const data = (await res.json()) as { user_id?: string };
  return data.user_id ?? "unknown";
}

/** Random 8-char uppercase alnum suffix for the fixed device ID. */
function randomDeviceSuffix(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Acquire a Matrix access token: password login (mode 1) or pasted token (mode 2).
 */
async function acquireToken(
  ask: (prompt: string, opts?: { silent?: boolean }) => Promise<string>,
  homeserver: string,
  deviceId?: string
): Promise<{ accessToken: string; botUserId: string }> {
  const authMode = ((await ask(t("setup.token.mode"))).trim() || "1");

  if (authMode === "2") {
    const accessToken = (await ask(t("setup.token.paste"))).trim();
    if (!accessToken) throw new Error(t("setup.token.empty"));
    const botUserId = await matrixWhoami(homeserver, accessToken);
    console.log(t("setup.token.valid", { user: botUserId }));
    return { accessToken, botUserId };
  }

  const username = (await ask(t("setup.token.username"))).trim();
  // 密码不回显(终端模式);普通模式会显示,注意遮挡
  const password = await ask(t("setup.token.password"), { silent: true });
  if (!username || !password) throw new Error(t("setup.token.credsEmpty"));
  console.log(t("setup.token.loggingIn"));
  const login = await matrixLogin(homeserver, username, password, deviceId);
  console.log(
    t("setup.token.loginOk", {
      user: login.userId,
      device: deviceId ? t("setup.token.loginDevice", { id: deviceId }) : "",
    })
  );
  return { accessToken: login.accessToken, botUserId: login.userId };
}

export async function runSetup(): Promise<void> {
  const { ask, close } = createPrompter();
  console.log("");

  try {
    // Existing config → prefill defaults on repeated runs.
    const existing = loadConfig();

    // ---- 0. language (issue #83) ------------------------------------------
    // Pre-detect the language with the same chain the service uses
    // (PI_LANGUAGE > config "language" > system locale): when it yields a
    // locale, the whole wizard — title included — renders in that language.
    // Only when nothing is usable (C/POSIX locale, fresh config) do we fall
    // back to the fixed bilingual title/prompt. The first question still
    // asks: Enter keeps the detected default, en/zh overrides it, and the
    // choice is persisted with the config so the running service never
    // depends on terminal-side locale again.
    const envLang = process.env.PI_LANGUAGE?.trim().toLowerCase();
    const preLang: Locale | null =
      envLang === "zh" || envLang === "en"
        ? envLang
        : (existing.language ?? detectSystemLanguage());
    if (preLang) setLocale(preLang);
    console.log(preLang ? t("setup.title") : "=== pi-courier setup wizard / 配置向导 ===");

    const langDefault: Locale = preLang ?? "en";
    const langRaw = (await ask(t("setup.languagePrompt", { def: langDefault }))).trim().toLowerCase();
    const lang: Locale = langRaw === "zh" || langRaw === "en" ? langRaw : langDefault;
    setLocale(lang);
    console.log(t("setup.header"));

    // ---- 1. homeserver ----------------------------------------------------
    const hsDefault = existing.matrix?.homeserverUrl ?? "";
    const hsPrompt = hsDefault
      ? t("setup.homeserver.default", { def: hsDefault })
      : t("setup.homeserver.plain");
    const homeserver = (await ask(hsPrompt)).trim() || hsDefault;
    if (!homeserver) throw new Error(t("setup.homeserver.empty"));

    // ---- 2.5 fixed device id ------------------------------------------------
    // Same bot account re-running setup reuses the same device (identity is
    // kept, history keys survive); delete the field to force a new device.
    // Only password login uses it; a pasted token keeps its own device.
    let deviceId = existing.deviceId;
    if (!deviceId) {
      deviceId = `PICOURIER${randomDeviceSuffix()}`;
    }

    // ---- 3. token ----------------------------------------------------------
    // Keep the existing token when the homeserver is unchanged; otherwise it
    // belongs to another server and must be re-acquired.
    const hsChanged = Boolean(hsDefault) && homeserver !== hsDefault;
    const existingToken = existing.matrix?.accessToken;

    let accessToken: string;
    let botUserId: string;
    if (existingToken && !hsChanged) {
      const keep = ((await ask(t("setup.token.keep"))).trim() || "y").toLowerCase();
      if (keep === "y") {
        accessToken = existingToken;
        botUserId = await matrixWhoami(homeserver, accessToken).catch(() => "unknown");
        console.log(t("setup.token.kept", { user: botUserId }));
      } else {
        ({ accessToken, botUserId } = await acquireToken(ask, homeserver, deviceId));
      }
    } else {
      if (hsChanged) console.log(t("setup.token.hsChanged"));
      ({ accessToken, botUserId } = await acquireToken(ask, homeserver, deviceId));
    }

    // ---- 4. trusted admin user ---------------------------------------------
    const trustedDefault = existing.auth?.trustedUsers?.[0] !== undefined
      ? nativeMxid(existing.auth.trustedUsers[0])
      : botUserId;
    const adminRaw = (await ask(t("setup.admin.prompt", { def: trustedDefault }))).trim() || trustedDefault;
    if (!adminRaw.startsWith("@")) throw new Error(t("setup.admin.badMxid"));

    // ---- 4.5 trusted rooms (optional) ---------------------------------------
    // Group chats need explicit channel authorization: trusted users in a
    // group are ignored unless the room is enabled. Format per room:
    //   !room:server            (mode defaults to trusted-only)
    //   !room:server:all|mentions|trusted-only
    const roomsRaw = (await ask(t("setup.rooms.prompt"))).trim();
    const rooms: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }> = {};
    if (roomsRaw) {
      for (const part of roomsRaw.split(",")) {
        const p = part.trim();
        if (!p) continue;
        let room = p;
        let mode: "all" | "mentions" | "trusted-only" = "trusted-only";
        const last = p.split(":").pop() ?? "";
        if (last === "all" || last === "mentions" || last === "trusted-only") {
          room = p.slice(0, p.length - last.length - 1);
          mode = last;
        }
        if (!room.startsWith("!")) {
          console.log(t("setup.rooms.invalid", { room: p }));
          continue;
        }
        rooms[room] = { enabled: true, mode };
      }
    }

    // ---- 5. E2EE ------------------------------------------------------------
    const encDefault = existing.matrix?.encryption === true;
    const encPrompt = encDefault ? t("setup.e2ee.defaultYes") : t("setup.e2ee.plain");
    const encAnswer = (await ask(encPrompt)).trim().toLowerCase();
    const encryption = encAnswer === "" ? encDefault : encAnswer === "y";

    // ---- 6. workdir ----------------------------------------------------------
    const workdirDefault = effectiveWorkdir(existing);
    const workdir = (await ask(t("setup.workdir.prompt", { def: workdirDefault }))).trim() || workdirDefault;

    // ---- 6.2 attachments (issue #66) ------------------------------------------
    // Where media from the chat lands and how big a single file may be.
    // Defaults are fine for almost everyone — the questions exist so the
    // knobs are discoverable, answers merge-preserve existing values.
    const attDirDefault = attachmentsDirectory(existing);
    const attachmentsDir = (await ask(t("setup.attach.dirPrompt", { def: attDirDefault }))).trim() || attDirDefault;
    const attMbDefault = attachmentsMaxMb(existing);
    const attMbRaw = (await ask(t("setup.attach.mbPrompt", { def: attMbDefault }))).trim();
    const attMb = attMbRaw === "" ? attMbDefault : Number.parseInt(attMbRaw, 10);
    if (!Number.isFinite(attMb) || attMb <= 0) {
      throw new Error(t("setup.attach.mbInvalid"));
    }

    // ---- 6.5 instance name (multi-machine differentiation) -------------------
    const instanceDefault = effectiveInstanceName(existing);
    const instanceName = (await ask(t("setup.instance.prompt", { def: instanceDefault }))).trim() || instanceDefault;

    // ---- 6.6 multi-project mode ----------------------------------------------
    const mpDefault = existing.multiProject === true;
    const mpRaw = (await ask(t("setup.multiProject.prompt"))).trim().toLowerCase();
    const multiProject = mpRaw === "y" || mpRaw === "yes" || (mpRaw === "" && mpDefault);

    // ---- 6.7 space (organizational, multi-project only) ----------------------
    // Fresh configs default ON (new deployments get the grouped view);
    // existing configs default to their current state — legacy configs stay
    // off until the user opts in. The prompt only appears with multi-project;
    // space.roomId etc. survive the merge untouched. "Fresh" is detected via
    // setup-written fields (deviceId/workdir/multiProject) — env vars can
    // inject matrix/auth keys without the wizard ever having run.
    const hasExistingConfig =
      existing.deviceId !== undefined ||
      existing.workdir !== undefined ||
      existing.multiProject !== undefined;
    const spaceDefault = hasExistingConfig ? existing.space?.enabled === true : true;
    let spaceEnabled = false;
    if (multiProject) {
      const spPrompt = spaceDefault ? t("setup.space.promptYes") : t("setup.space.promptNo");
      const spRaw = (await ask(spPrompt)).trim().toLowerCase();
      spaceEnabled = spRaw === "" ? spaceDefault : spRaw === "y" || spRaw === "yes";
    }

    // ---- merge & save --------------------------------------------------------
    // Keep untouched fields (sessionDir / cliPath / logLevel / hideToolCalls …)
    // from the existing config instead of overwriting the whole file.
    const merged: MsgBridgeConfig = {
      ...existing,
      language: lang,
      matrix: { homeserverUrl: homeserver, accessToken, encryption },
      auth: {
        ...existing.auth,
        trustedUsers: [`matrix:${adminRaw}`],
        adminUserId: `matrix:${adminRaw}`,
        ...(roomsRaw ? { channels: rooms } : {}),
      },
      workdir,
      instanceName,
      multiProject,
      attachments: { ...existing.attachments, directory: attachmentsDir, maxMb: attMb },
      // Single-project reruns leave the space fields exactly as they were
      // (no silent enabled flip) — the feature is multi-project-only.
      ...(multiProject ? { space: { ...existing.space, enabled: spaceEnabled } } : {}),
      deviceId,
      autoConnect: existing.autoConnect ?? true,
      debug: existing.debug ?? true,
    };
    saveConfig(merged);

    console.log(t("setup.done.title"));
    console.log(t("setup.done.account", { user: botUserId }));
    console.log(t("setup.done.trusted", { user: adminRaw }));
    console.log(t("setup.done.e2ee", { state: encryption ? t("common.enabled") : t("common.disabled") }));
    console.log(t("setup.done.workdir", { workdir }));
    console.log(t("setup.done.attachments", { dir: attachmentsDir, max: attMb }));
    console.log(t("setup.done.instance", { name: instanceName }));
    console.log(
      t("setup.done.multiProject", { state: multiProject ? t("common.enabled") : t("setup.done.multiProjectOff") })
    );
    if (multiProject) {
      console.log(t("setup.done.space", { state: spaceEnabled ? t("setup.space.stateOn") : t("common.disabled") }));
    }
    console.log(t("setup.done.deviceId", { id: deviceId }));
    const roomList = Object.entries(rooms).map(([id, c]) => `${id} (${c.mode})`).join(", ");
    console.log(t("setup.done.rooms", { rooms: roomList || t("setup.done.noRooms") }));
    console.log(t("setup.next"));
  } catch (err) {
    console.error(t("setup.failed", { message: (err as Error).message }));
    process.exitCode = 1;
  } finally {
    close(); // release stdin listeners so the process exits naturally
  }
}