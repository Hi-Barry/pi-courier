/**
 * Interactive first-run setup wizard.
 *
 * Usage: node dist/standalone.js --setup
 *
 * Walks through: Matrix homeserver → bot login (or pasted token) → trusted
 * admin user → E2EE toggle, then writes ~/.pi/pi-courier.json.
 */

import * as os from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig } from "./config.js";
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
    throw new Error(`登录失败 (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string; user_id?: string };
  if (!data.access_token) throw new Error("登录响应缺少 access_token");
  return { accessToken: data.access_token, userId: data.user_id ?? "" };
}

async function matrixWhoami(homeserver: string, accessToken: string): Promise<string> {
  const url = `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`token 验证失败 (HTTP ${res.status})`);
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
  const authMode = ((await ask("获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1): ")).trim() || "1");

  if (authMode === "2") {
    const accessToken = (await ask("粘贴 access token (syt_...): ")).trim();
    if (!accessToken) throw new Error("token 不能为空");
    const botUserId = await matrixWhoami(homeserver, accessToken);
    console.log(`✅ token 有效,账号: ${botUserId}`);
    return { accessToken, botUserId };
  }

  const username = (await ask("bot 用户名 (如 test2): ")).trim();
  // 密码不回显(终端模式);普通模式会显示,注意遮挡
  const password = await ask("bot 密码: ", { silent: true });
  if (!username || !password) throw new Error("用户名/密码不能为空");
  console.log("登录中…");
  const login = await matrixLogin(homeserver, username, password, deviceId);
  console.log(`✅ 登录成功,账号: ${login.userId}${deviceId ? `(设备 ${deviceId})` : ""}`);
  return { accessToken: login.accessToken, botUserId: login.userId };
}

export async function runSetup(): Promise<void> {
  const { ask, close } = createPrompter();
  console.log("");
  console.log("=== pi-courier 配置向导 ===");
  console.log("将写入 ~/.pi/pi-courier.json(权限 600;已有配置作为默认值,直接回车沿用)\n");

  try {
    // Existing config → prefill defaults on repeated runs.
    const existing = loadConfig();

    // ---- 1. homeserver ----------------------------------------------------
    const hsDefault = existing.matrix?.homeserverUrl ?? "";
    const hsPrompt = hsDefault
      ? `Matrix homeserver URL [默认 ${hsDefault}]: `
      : "Matrix homeserver URL (如 https://matrix.example.com): ";
    const homeserver = (await ask(hsPrompt)).trim() || hsDefault;
    if (!homeserver) throw new Error("homeserver URL 不能为空");

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
      const keep = ((await ask("保留现有 token? [Y/n]: ")).trim() || "y").toLowerCase();
      if (keep === "y") {
        accessToken = existingToken;
        botUserId = await matrixWhoami(homeserver, accessToken).catch(() => "unknown");
        console.log(`✅ 沿用现有 token,账号: ${botUserId}`);
      } else {
        ({ accessToken, botUserId } = await acquireToken(ask, homeserver, deviceId));
      }
    } else {
      if (hsChanged) console.log("ℹ️  homeserver 已变更,需要重新获取 token");
      ({ accessToken, botUserId } = await acquireToken(ask, homeserver, deviceId));
    }

    // ---- 4. trusted admin user ---------------------------------------------
    const trustedDefault = existing.auth?.trustedUsers?.[0]?.replace(/^matrix:/, "") ?? botUserId;
    const adminRaw = (await ask(`信任用户(管理员)MXID [默认 ${trustedDefault}]: `)).trim() || trustedDefault;
    if (!adminRaw.startsWith("@")) throw new Error("MXID 应以 @ 开头,如 @barry:matrix.example.com");

    // ---- 4.5 trusted rooms (optional) ---------------------------------------
    // Group chats need explicit channel authorization: trusted users in a
    // group are ignored unless the room is enabled. Format per room:
    //   !room:server            (mode defaults to trusted-only)
    //   !room:server:all|mentions|trusted-only
    const roomsRaw = (
      await ask("信任房间 ID(可选,回车跳过;多个逗号分隔,如 !abc:server 或 !abc:server:trusted-only): ")
    ).trim();
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
          console.log(`   ⚠️ 跳过无效房间 ID: ${p}(应以 ! 开头)`);
          continue;
        }
        rooms[room] = { enabled: true, mode };
      }
    }

    // ---- 5. E2EE ------------------------------------------------------------
    const encDefault = existing.matrix?.encryption === true;
    const encPrompt = encDefault
      ? "启用 E2EE 加密? [Y/n] [默认 是]: "
      : "启用 E2EE 加密? [y/N]: ";
    const encAnswer = (await ask(encPrompt)).trim().toLowerCase();
    const encryption = encAnswer === "" ? encDefault : encAnswer === "y";

    // ---- 6. workdir ----------------------------------------------------------
    const workdirDefault = existing.workdir ?? `${os.homedir()}/Projects`;
    const workdir = (await ask(`pi 工作目录 [默认 ${workdirDefault}]: `)).trim() || workdirDefault;

    // ---- 6.5 instance name (multi-machine differentiation) -------------------
    const instanceDefault = existing.instanceName ?? os.hostname();
    const instanceName = (await ask(`实例名/机器名(默认 ${instanceDefault};多台部署用来区分,将显示在管理房间名): `)).trim() || instanceDefault;

    // ---- 6.6 multi-project mode ----------------------------------------------
    const mpDefault = existing.multiProject === true;
    const mpRaw = (await ask(`启用多工程模式? [y/N](多工程=管理房间+项目房间隔离,可用 /pmctl;默认 N=单工程,一个 bot 对应一个 pi): `)).trim().toLowerCase();
    const multiProject = mpRaw === "y" || mpRaw === "yes" || (mpRaw === "" && mpDefault);

    // ---- merge & save --------------------------------------------------------
    // Keep untouched fields (sessionDir / cliPath / logLevel / hideToolCalls …)
    // from the existing config instead of overwriting the whole file.
    const merged: MsgBridgeConfig = {
      ...existing,
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
      deviceId,
      autoConnect: existing.autoConnect ?? true,
      debug: existing.debug ?? true,
    };
    saveConfig(merged);

    console.log("\n✅ 配置已写入 ~/.pi/pi-courier.json");
    console.log(`   账号: ${botUserId}`);
    console.log(`   信任用户: ${adminRaw}`);
    console.log(`   E2EE: ${encryption ? "开启" : "关闭"}`);
    console.log(`   工作目录: ${workdir}`);
    console.log(`   实例名: ${instanceName}(用于多台部署区分,显示在管理房间名)`);
    console.log(`   多工程: ${multiProject ? "开启" : "关闭(单工程)"}`);
    console.log(`   设备 ID: ${deviceId}(固定,重跑 setup 复用;想换设备就删掉此字段)`);
    const roomList = Object.entries(rooms).map(([id, c]) => `${id} (${c.mode})`).join(", ");
    console.log(`   信任房间: ${roomList || "无(群聊默认不回应;可后续用 /enable 添加)"}`);
    console.log("\n下一步: pi-courier enable(开机自启)或 pi-courier run(前台运行)");
  } catch (err) {
    console.error(`\n❌ 配置失败: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    close(); // release stdin listeners so the process exits naturally
  }
}