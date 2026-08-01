/**
 * Interactive first-run setup wizard.
 *
 * Usage: node dist/standalone.js --setup
 *
 * Walks through: Matrix homeserver → bot login (or pasted token) → trusted
 * admin user → E2EE toggle, then writes ~/.pi/msg-bridge.json.
 */

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { saveConfig } from "./config.js";

/**
 * Input abstraction that works in both modes:
 *  - TTY: interactive question() (echoes prompt, reads one line at a time)
 *  - piped/closed stdin: pre-read all lines, consume in order (no line loss,
 *    which readline.question suffers from when input is buffered)
 * Returns { ask, close } — close() releases stdin listeners so the process
 * can exit naturally after setup finishes.
 */
function createPrompter(): {
  ask: (prompt: string) => Promise<string>;
  close: () => void;
} {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout });
    return {
      ask: (prompt) =>
        new Promise((resolve) => {
          let done = false;
          const finish = (answer: string): void => {
            if (!done) {
              done = true;
              resolve(answer);
            }
          };
          rl.question(prompt, finish);
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
  password: string
): Promise<{ accessToken: string; userId: string }> {
  const url = `${homeserver.replace(/\/$/, "")}/_matrix/client/v3/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
    }),
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

export async function runSetup(): Promise<void> {
  const { ask, close } = createPrompter();
  console.log("");
  console.log("=== pi-remote 首次配置向导 ===");
  console.log("将生成 ~/.pi/msg-bridge.json(权限 600)\n");

  try {
    const platform = ((await ask("选择 messenger 平台 [matrix]: ")) || "matrix").toLowerCase();

    if (platform !== "matrix") {
      console.log(`\n⚠️  向导目前仅支持 matrix。请手动编辑 ~/.pi/msg-bridge.json 配置 ${platform}(格式见 docs/DEPLOYMENT.md §3.4)。`);
      return;
    }

    const homeserver = (await ask("Matrix homeserver URL (如 https://matrix.example.com): ")).trim();
    if (!homeserver) throw new Error("homeserver URL 不能为空");

    const authMode =
      (await ask("获取 token 方式 [1=用户名密码登录, 2=粘贴已有 token] (1): ")).trim() || "1";

    let accessToken: string;
    let botUserId: string;
    if (authMode === "2") {
      accessToken = (await ask("粘贴 access token (syt_...): ")).trim();
      if (!accessToken) throw new Error("token 不能为空");
      botUserId = await matrixWhoami(homeserver, accessToken);
      console.log(`✅ token 有效,账号: ${botUserId}`);
    } else {
      const username = (await ask("bot 用户名 (如 test2): ")).trim();
      // 密码不回显(终端模式);普通模式会显示,注意遮挡
      const password = await ask("bot 密码: ");
      if (!username || !password) throw new Error("用户名/密码不能为空");
      console.log("登录中…");
      const login = await matrixLogin(homeserver, username, password);
      accessToken = login.accessToken;
      botUserId = login.userId;
      console.log(`✅ 登录成功,账号: ${botUserId}`);
    }

    const adminDefault = botUserId.replace(/^@/, "").split(":")[0];
    const adminRaw = (await ask(`信任用户(管理员)MXID [默认 ${botUserId}]: `)).trim() || botUserId;
    if (!adminRaw.startsWith("@")) throw new Error("MXID 应以 @ 开头,如 @barry:matrix.example.com");

    const encryption = (await ask("启用 E2EE 加密? [y/N]: ")).trim().toLowerCase() === "y";

    saveConfig({
      matrix: { homeserverUrl: homeserver, accessToken, encryption },
      auth: {
        trustedUsers: [`matrix:${adminRaw}`],
        adminUserId: `matrix:${adminRaw}`,
      },
      autoConnect: true,
      debug: true,
    });

    console.log("\n✅ 配置已写入 ~/.pi/msg-bridge.json");
    console.log(`   账号: ${botUserId}`);
    console.log(`   信任用户: ${adminRaw}`);
    console.log(`   E2EE: ${encryption ? "开启" : "关闭"}`);
    console.log("\n现在可以启动: node dist/standalone.js --workdir /path/to/project");
  } catch (err) {
    console.error(`\n❌ 配置失败: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    close(); // release stdin listeners so the process exits naturally
  }
}