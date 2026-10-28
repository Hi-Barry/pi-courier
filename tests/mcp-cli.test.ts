/**
 * McpCli 执行缝的单测(spec #246):全部经注入的假 spawn 完成,不跑真实
 * pi、不连外部服务器。断言重点:argv 形状(node <cli.js> mcp …)、list 的
 * 「按 JSON 内容判定成败、退出码非零不误报」、版本门(unavailable)分流、
 * 超时兜底、login 逐行上抛与 --timeout 钳制。
 * 假件结构仿 tests/update-upgrade.test.ts 的 FakeChild 先例。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addServer,
  listServers,
  logoutServer,
  MCP_LOGIN_DEFAULT_TIMEOUT_S,
  MCP_LOGIN_KILL_GRACE_MS,
  MCP_LOGIN_TIMEOUT_MAX_S,
  MCP_SHORT_TIMEOUT_MS,
  removeServer,
  startLogin,
  type McpChild,
  type McpCliDeps,
  type McpOutcome,
  type McpSpawn,
} from "../src/mcp/mcp-cli.js";
import type { McpLoginLine } from "../src/mcp/mcp-formatters.js";

// ----------------------------------------------------------------假件基建

interface FakeChild extends McpChild {
  emit(event: string, ...args: unknown[]): void;
}

function makeFakeChild(): FakeChild {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const add = (event: string, cb: (...args: any[]) => void) => {
    const list = listeners.get(event) ?? [];
    list.push(cb);
    listeners.set(event, list);
  };
  return {
    stdout: { on: (event, cb) => add(`stdout:${event}`, cb) },
    stderr: { on: (event, cb) => add(`stderr:${event}`, cb) },
    on: (event, cb) => add(event, cb),
    once: (event, cb) => add(event, cb),
    kill: vi.fn(() => true),
    emit: (event, ...args) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: { cwd?: string };
}

function harness(overrides: Partial<McpCliDeps> = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: McpSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = makeFakeChild();
    children.push(child);
    return child;
  };
  const deps: McpCliDeps = {
    spawn,
    resolveCliPath: async () => "/pi/dist/cli.js",
    nodeExecPath: "/node/bin/node",
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
  return { calls, children, deps };
}

/** 等微任务里(resolveCliPath 之后)的 spawn 真的发生,返回该假子进程。 */
async function untilSpawned(h: ReturnType<typeof harness>): Promise<FakeChild> {
  for (let i = 0; i < 50 && h.children.length === 0; i += 1) {
    await Promise.resolve();
  }
  const child = h.children[0];
  if (!child) throw new Error("假件下 spawn 未发生");
  return child;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------常量

describe("超时常量(契约钉)", () => {
  it("短命令统一 120s;login 硬上限 600s;SIGKILL 宽限 10s;login 缺省 300s", () => {
    expect(MCP_SHORT_TIMEOUT_MS).toBe(120_000);
    expect(MCP_LOGIN_TIMEOUT_MAX_S).toBe(600);
    expect(MCP_LOGIN_KILL_GRACE_MS).toBe(10_000);
    expect(MCP_LOGIN_DEFAULT_TIMEOUT_S).toBe(300);
  });
});

// ----------------------------------------------------------------listServers

describe("listServers · list --json 成败按 JSON 内容判定", () => {
  it("argv 形状:node <pi-cli.js> mcp list --json(定位链经注入的 resolveCliPath)", async () => {
    const h = harness();
    const promise = listServers(h.deps);
    const child = await untilSpawned(h);
    child.emit("stdout:data",Buffer.from('{"servers":[],"errors":[]}'));
    child.emit("close", 0);
    const outcome = await promise;
    expect(outcome.kind).toBe("ok");
    expect(h.calls[0]).toEqual({
      cmd: "/node/bin/node",
      args: ["/pi/dist/cli.js", "mcp", "list", "--json"],
      opts: {},
    });
  });

  it("退出码 1 + 合法 JSON → 仍 ok:任一服务器未连接的非零退出不得误报全失败", async () => {
    const h = harness();
    const promise = listServers(h.deps);
    const child = await untilSpawned(h);
    child.emit(
      "stdout:data",
      Buffer.from(
        JSON.stringify({
          servers: [
            { name: "ok-one", state: "connected", tools: ["t"] },
            { name: "down", state: "needs-auth", tools: [], error: "401" },
          ],
          errors: [],
        }),
      ),
    );
    child.emit("close", 1); // pi 对未连接服务器即退出非零
    const outcome = await promise;
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.data.servers.map((s) => s.name)).toEqual(["ok-one", "down"]);
    }
  });

  it("stdout 非 JSON(pi 缺失旧版会喂模型)+ stderr 带 Unknown mcp command → unavailable", async () => {
    const h = harness();
    const promise = listServers(h.deps);
    const child = await untilSpawned(h);
    child.emit("stderr:data",Buffer.from('Unknown mcp command "list".\nUse "pi mcp --help" for usage.'));
    child.emit("close", 1);
    const outcome = await promise;
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") expect(outcome.message).toContain("Unknown mcp command");
  });

  it("spawn 同步抛错(ENOENT = pi 缺失)→ unavailable", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const outcome = await listServers(h.deps);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") expect(outcome.message).toContain("spawn ENOENT");
  });

  it("stdout 是任意文本(旧版 pi 把命令喂了模型)且无 unknown 特征 → failed 并带原文尾部", async () => {
    const h = harness();
    const promise = listServers(h.deps);
    const child = await untilSpawned(h);
    child.emit("stdout:data",Buffer.from("好的,我来帮你列出 MCP 服务器……(模型回复)"));
    child.emit("close", 0);
    const outcome = await promise;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("未返回可解析的 JSON");
  });

  it("挂死兜底:120s 到点 SIGKILL → failed(短命令统一上限)", async () => {
    vi.useFakeTimers();
    const h = harness({ shortTimeoutMs: 120_000 });
    const promise = listServers(h.deps);
    const child = await untilSpawned(h);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
    const outcome = await promise;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("超时(120s)");
  });
});

// ----------------------------------------------------------------短命令三件

describe("addServer / removeServer / logoutServer · argv 与成败分流", () => {
  it("add:addArgs 原样透传,node <cli> mcp add <…>;退出码 0 → ok 带 pi 文案与确认形状", async () => {
    const h = harness();
    const addArgs = ["docs", "--url", "https://x.dev/mcp", "--header", "K=V"];
    const promise = addServer(addArgs, h.deps);
    const child = await untilSpawned(h);
    child.emit("stdout:data",Buffer.from('Added global MCP server "docs" in /root/.pi/agent/mcp.json.'));
    child.emit("close", 0);
    const outcome = await promise;
    expect(outcome).toEqual({
      kind: "ok",
      data: 'Added global MCP server "docs" in /root/.pi/agent/mcp.json.',
      confirmed: true,
    });
    expect(h.calls[0]!.args).toEqual(["/pi/dist/cli.js", "mcp", "add", ...addArgs]);
  });

  it("add:非零退出 → failed 带 stderr 尾部(用法错误原样透传)", async () => {
    const h = harness();
    const promise = addServer(["docs"], h.deps);
    const child = await untilSpawned(h);
    child.emit("stderr:data",Buffer.from("Usage: pi mcp add <server> [options] (--url <url> | -- <command> [args...])"));
    child.emit("close", 1);
    const outcome = await promise;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.message).toContain("Usage: pi mcp add");
  });

  it("remove / logout:argv 形状与 ok/failed 分流", async () => {
    const hRemove = harness();
    const pRemove = removeServer("docs", hRemove.deps);
    const cRemove = await untilSpawned(hRemove);
    cRemove.emit("stdout:data", Buffer.from('Removed global MCP server "docs" from /root/.pi/agent/mcp.json.'));
    cRemove.emit("close", 0);
    expect(await pRemove).toMatchObject({ kind: "ok" });
    expect(hRemove.calls[0]!.args).toEqual(["/pi/dist/cli.js", "mcp", "remove", "docs"]);

    const hLogout = harness();
    const pLogout = logoutServer("docs", hLogout.deps);
    const cLogout = await untilSpawned(hLogout);
    cLogout.emit("stderr:data", Buffer.from('No stored OAuth credentials for "docs".'));
    cLogout.emit("close", 1);
    const logout = await pLogout;
    expect(logout.kind).toBe("failed");
    if (logout.kind === "failed") expect(logout.message).toContain("No stored OAuth credentials");
    expect(hLogout.calls[0]!.args).toEqual(["/pi/dist/cli.js", "mcp", "logout", "docs"]);
  });

  it("remove:未知子命令特征 → unavailable(版本门)", async () => {
    const h = harness();
    const promise = removeServer("docs", h.deps);
    const child = await untilSpawned(h);
    child.emit("stderr:data",Buffer.from('Unknown mcp command "remove".'));
    child.emit("close", 1);
    expect((await promise).kind).toBe("unavailable");
  });
});

// ----------------------------------------------------------------入口解析失败(版本门)

describe("pi 入口解析失败 → unavailable(不冒泡到 router 外层)", () => {
  const throwingDeps = (): McpCliDeps => ({
    resolveCliPath: async () => {
      throw new Error("Cannot locate the pi CLI. Install … or set PI_CLI_PATH.");
    },
    spawn: () => {
      throw new Error("测试不应触达 spawn");
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  it("四个短命令都结 unavailable(带解析错误详情),不抛错", async () => {
    for (const call of [
      () => listServers(throwingDeps()),
      () => addServer(["docs"], throwingDeps()),
      () => removeServer("docs", throwingDeps()),
      () => logoutServer("docs", throwingDeps()),
    ] as const) {
      const outcome = await call();
      expect(outcome.kind).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.message).toContain("无法定位 pi CLI");
        expect(outcome.message).toContain("Cannot locate the pi CLI");
      }
    }
  });

  it("startLogin 以 unavailable 字段收口:不 spawn、不抛错", async () => {
    const result = await startLogin("corp", 300, () => {}, throwingDeps());
    expect(result.unavailable).toContain("无法定位 pi CLI");
    expect(result.unavailable).toContain("Cannot locate the pi CLI");
    expect(result.code).toBeUndefined();
    expect(result.timedOut).toBe(false);
  });
});

// ----------------------------------------------------------------突变确认形状

describe("突变确认形状(旧版 pi 把命令当 prompt 的降级信号)", () => {
  async function runMutation(
    call: (deps: McpCliDeps) => ReturnType<typeof addServer>,
    stdout: string,
  ): Promise<McpOutcome<string>> {
    const h = harness();
    const promise = call(h.deps);
    const child = await untilSpawned(h);
    if (stdout.length > 0) child.emit("stdout:data", Buffer.from(stdout));
    child.emit("close", 0);
    return promise;
  }

  it("add:pi 1.0 的 Added/Replaced 确认 → confirmed=true;模型回复 → confirmed=false", async () => {
    const confirmed = await runMutation(
      (deps) => addServer(["docs"], deps),
      'Added global MCP server "docs" in /root/.pi/agent/mcp.json.\nCheck it with: pi mcp list',
    );
    expect(confirmed).toMatchObject({ kind: "ok", confirmed: true });

    const replaced = await runMutation(
      (deps) => addServer(["docs"], deps),
      'Replaced global MCP server "docs" in /root/.pi/agent/mcp.json.',
    );
    expect(replaced).toMatchObject({ kind: "ok", confirmed: true });

    const promptEcho = await runMutation(
      (deps) => addServer(["docs"], deps),
      "好的,我来帮你在 MCP 配置里添加 docs 服务器……(模型回复)",
    );
    expect(promptEcho).toMatchObject({ kind: "ok", confirmed: false });
  });

  it("remove:Removed 确认 → true;模型回复 → false", async () => {
    const confirmed = await runMutation(
      (deps) => removeServer("docs", deps),
      'Removed global MCP server "docs" from /root/.pi/agent/mcp.json.',
    );
    expect(confirmed).toMatchObject({ kind: "ok", confirmed: true });
    const promptEcho = await runMutation((deps) => removeServer("docs", deps), "已为你移除 docs。");
    expect(promptEcho).toMatchObject({ kind: "ok", confirmed: false });
  });

  it("logout:Signed out 确认 → true;No stored credentials(exit 0 正常路径)→ true;模型回复 → false", async () => {
    const confirmed = await runMutation(
      (deps) => logoutServer("docs", deps),
      'Signed out of MCP server "docs".',
    );
    expect(confirmed).toMatchObject({ kind: "ok", confirmed: true });
    // pi 1.0 对「无已存凭证」同样 exit 0(cli.js:175):重复登出/从未登录过
    // 的 OAuth 服务器走此支,必须算确认,不得误报成「旧版 pi 当提示词」。
    const noCreds = await runMutation(
      (deps) => logoutServer("docs", deps),
      'No stored credentials for MCP server "docs".',
    );
    expect(noCreds).toMatchObject({ kind: "ok", confirmed: true });
    const promptEcho = await runMutation((deps) => logoutServer("docs", deps), "已经帮你登出了。");
    expect(promptEcho).toMatchObject({ kind: "ok", confirmed: false });
  });
});

// ----------------------------------------------------------------startLogin

describe("startLogin · 长命令逐行上抛与 --timeout 钳制", () => {
  function captureLines(): { lines: McpLoginLine["kind"][]; raw: string[]; onLine: (line: string) => void } {
    const raw: string[] = [];
    return {
      lines: [],
      raw,
      onLine: (line) => raw.push(line),
    };
  }

  it("argv:node <cli> mcp login <名> --timeout <秒>;正常值原样透传", async () => {
    const h = harness();
    const cap = captureLines();
    const promise = startLogin("corp", 300, cap.onLine, h.deps);
    const child = await untilSpawned(h);
    child.emit("close", 0);
    await promise;
    expect(h.calls[0]!.args).toEqual(["/pi/dist/cli.js", "mcp", "login", "corp", "--timeout", "300"]);
  });

  it("--timeout 钳制:700 → 600(桥侧硬上限);0 / NaN → 缺省 300", async () => {
    for (const [input, expected] of [
      [700, "600"],
      [0, "300"],
      [Number.NaN, "300"],
    ] as const) {
      const h = harness();
      const cap = captureLines();
      const promise = startLogin("corp", input, cap.onLine, h.deps);
      const child = await untilSpawned(h);
      child.emit("close", 0);
      await promise;
      expect(h.calls[0]!.args.slice(-2)).toEqual(["--timeout", expected]);
    }
  });

  it("stdout 逐行上抛:跨 chunk 残行拼接;close 时不带换行的尾行不丢", async () => {
    const h = harness();
    const cap = captureLines();
    const promise = startLogin("corp", 300, cap.onLine, h.deps);
    const child = await untilSpawned(h);
    child.emit("stdout:data",Buffer.from('Sign in to MCP server "corp" in your browser:\n'));
    child.emit("stdout:data",Buffer.from("https://auth.example.com/authorize?state=x"));
    child.emit("stdout:data",Buffer.from("z&code=1\npartial tail"));
    child.emit("close", 0);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(cap.raw).toEqual([
      'Sign in to MCP server "corp" in your browser:',
      "https://auth.example.com/authorize?state=xz&code=1",
      "partial tail",
    ]);
  });

  it("桥侧兜底:--timeout 秒 + 宽限期到点才 SIGKILL,timedOut=true;pi 自己的 600s 内退出不算超时", async () => {
    vi.useFakeTimers();
    const h = harness();
    const cap = captureLines();
    const promise = startLogin("corp", 600, cap.onLine, h.deps);
    const child = await untilSpawned(h);
    // 600s 整(pi 自身超时点):宽限未过,不杀。
    await vi.advanceTimersByTimeAsync(600_000);
    expect(child.kill).not.toHaveBeenCalled();
    // +10s 宽限到点:SIGKILL。
    await vi.advanceTimersByTimeAsync(MCP_LOGIN_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("stderr:data",Buffer.from('Sign-in to MCP server "corp" was cancelled or not completed within 600 seconds.'));
    child.emit("close", null);
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.stderr).toContain("was cancelled or not completed");
  });

  it("spawn 同步抛错 → spawnError 带出,不崩进程", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const cap = captureLines();
    const result = await startLogin("corp", 300, cap.onLine, h.deps);
    expect(result.spawnError).toContain("spawn ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("子进程 error 事件(spawn 后失败)→ spawnError 带出且 close 正常收口", async () => {
    const h = harness();
    const cap = captureLines();
    const promise = startLogin("corp", 300, cap.onLine, h.deps);
    const child = await untilSpawned(h);
    child.emit("error", new Error("spawn EACCES"));
    child.emit("close", null);
    const result = await promise;
    expect(result.spawnError).toContain("spawn EACCES");
    expect(result.code).toBeUndefined();
  });
});
