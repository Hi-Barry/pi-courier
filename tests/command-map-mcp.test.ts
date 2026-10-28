/**
 * /mcp 指令族命令层测试(spec #246):handleSlashCommand 的 case "/mcp"。
 * 编排槽一律喂假件(短命令返回可配置 outcome;登录用真实 McpLoginFlow +
 * 假 runLogin 执行缝,同时锚定编排器与命令层的对接),真实 pi 与外部 MCP
 * 服务器不进测试。
 *
 * 断言重点:守卫链(未装配→未启用 / 非管理员→拒绝 / 守卫先行零编排调用)、
 * 子命令分派(裸 /mcp=list、list 两段式、add/remove/logout/login/help、
 * 未知子命令→用法)、回执安全(--env/--header 的值不回显、成功回执不透传
 * pi stdout、审计只落服务器名)、登录编排(发起/URL 转发/终局回执+审计/
 * busy 单飞拒绝/--timeout 解析与钳制)。
 */
import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../src/audit/audit-log";
import { handleSlashCommand, type McpCommandContext, type McpOrchestration, type SlashCommandContext } from "../src/rpc/command-map";
import type { PiRpc } from "../src/rpc/pi-rpc";
import type { McpCliDeps, McpLoginResult, McpOutcome } from "../src/mcp/mcp-cli";
import { McpLoginFlow } from "../src/mcp/mcp-login-flow";
import type { McpListPayload } from "../src/mcp/mcp-formatters";

// ----------------------------------------------------------------假件基建

interface RecordedAudit {
  event: string;
  detail?: string;
}

interface Harness {
  replies: string[];
  audits: RecordedAudit[];
  /** 短命令的调用记录(add 收到的 argv 原样透传)。 */
  addCalls: string[][];
  removeCalls: string[];
  logoutCalls: string[];
  listCalls: number;
  /** 登录执行缝的一次调用(挂起中的流)。 */
  loginCalls: Array<{
    server: string;
    timeoutSec: number;
    onLine: (line: string) => void;
    resolve: (result: McpLoginResult) => void;
  }>;
  ctx: SlashCommandContext;
  /** 给最近一条登录流上抛一行 stdout / 收尾。 */
  emit(line: string): void;
  finishLogin(partial?: Partial<McpLoginResult>): Promise<void>;
}

interface FakeOutcomeConfig {
  list?: McpOutcome<McpListPayload>;
  add?: McpOutcome<string>;
  remove?: McpOutcome<string>;
  logout?: McpOutcome<string>;
  adminAllowed?: boolean;
}

function harness(config: FakeOutcomeConfig = {}): Harness {
  const replies: string[] = [];
  const audits: RecordedAudit[] = [];
  const addCalls: string[][] = [];
  const removeCalls: string[] = [];
  const logoutCalls: string[] = [];
  let listCalls = 0;
  const loginCalls: Harness["loginCalls"] = [];
  const loginFlow = new McpLoginFlow({
    loginTimeoutMaxS: 600,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runLogin: (server, timeoutSec, onLine) =>
      new Promise<McpLoginResult>((resolve) => {
        loginCalls.push({ server, timeoutSec, onLine, resolve });
      }),
  });
  const orchestration: McpOrchestration = {
    list: () => {
      listCalls += 1;
      return Promise.resolve(config.list ?? { kind: "ok", data: { servers: [] } });
    },
    add: (argv) => {
      addCalls.push([...argv]);
      return Promise.resolve(config.add ?? { kind: "ok", data: "" });
    },
    remove: (name) => {
      removeCalls.push(name);
      return Promise.resolve(config.remove ?? { kind: "ok", data: "" });
    },
    logout: (name) => {
      logoutCalls.push(name);
      return Promise.resolve(config.logout ?? { kind: "ok", data: "" });
    },
    login: loginFlow,
  };
  const ctx: SlashCommandContext = {
    rpc: {} as PiRpc,
    reply: async (text) => {
      replies.push(text);
    },
    audit: (event, detail) => {
      audits.push({ event, detail });
    },
    mcp: {
      ...orchestration,
      adminAllowed: config.adminAllowed ?? true,
    } satisfies McpCommandContext,
  };
  return {
    replies,
    audits,
    addCalls,
    removeCalls,
    logoutCalls,
    get listCalls() {
      return listCalls;
    },
    loginCalls,
    ctx,
    emit: (line) => {
      loginCalls.at(-1)!.onLine(line);
    },
    finishLogin: async (partial: Partial<McpLoginResult> = {}) => {
      loginCalls.at(-1)!.resolve({ code: 0, timedOut: false, stdout: "", stderr: "", ...partial });
      // 等编排器结算与 onFinished 回执落定(微任务排空)。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** 断言命令被处理(handled=true)。 */
async function runOrThrow(h: Harness, text: string): Promise<void> {
  const handled = await handleSlashCommand(text, h.ctx);
  if (!handled) throw new Error(`/${text} 未被处理`);
}

// ----------------------------------------------------------------守卫链

describe("/mcp 守卫链", () => {
  it("编排槽未装配 → 「未启用」回执,不落回 pi、不抛错", async () => {
    const h = harness();
    h.ctx.mcp = undefined;
    await runOrThrow(h, "/mcp list");
    expect(h.replies).toEqual(["❌ MCP 管理在当前部署未启用。"]);
    expect(h.listCalls).toBe(0);
  });

  it("非管理员(adminAllowed=false)→ 拒绝回执,编排槽零调用", async () => {
    const h = harness({ adminAllowed: false });
    await runOrThrow(h, "/mcp list");
    expect(h.replies).toEqual(["❌ /mcp 仅管理员可用(多工程模式下仅管理房间可用)。"]);
    expect(h.listCalls).toBe(0);
    await runOrThrow(h, "/mcp add x --url https://x");
    expect(h.addCalls).toHaveLength(0);
    await runOrThrow(h, "/mcp login x");
    expect(h.loginCalls).toHaveLength(0);
  });

  it("守卫先行:已装配 + 管理员 → 正常进入分派", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp help");
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain("MCP 服务器管理");
  });
});

// ----------------------------------------------------------------分派与回执

describe("/mcp list(裸 /mcp 同义)", () => {
  it("先「检查中」再出状态卡(两段式)", async () => {
    const h = harness({
      list: {
        kind: "ok",
        data: {
          servers: [
            { name: "corp", state: "connected", tools: ["search"], exposure: "codemode", scope: "global" },
            { name: "lab", state: "needs-auth" },
          ],
        },
      },
    });
    await runOrThrow(h, "/mcp");
    expect(h.replies[0]).toBe("⏳ 正在检查 MCP 服务器状态…");
    expect(h.replies[1]).toContain("MCP 服务器(2)");
    expect(h.replies[1]).toContain("corp — 已连接");
    expect(h.replies[1]).toContain("lab — 待登录");
    expect(h.replies[1]).toContain("/mcp login lab");
  });

  it("unavailable → pi 版本门回执(需 pi ≥ 1.0)", async () => {
    const h = harness({ list: { kind: "unavailable", message: "无法启动 pi CLI:spawn ENOENT" } });
    await runOrThrow(h, "/mcp list");
    expect(h.replies[1]).toBe(
      "❌ MCP 管理不可用(无法启动 pi CLI:spawn ENOENT)。\n本机的 pi 可能未安装或版本过旧:mcp 子命令需 pi ≥ 1.0。",
    );
  });

  it("failed → 失败回执带诊断", async () => {
    const h = harness({ list: { kind: "failed", message: "pi mcp list 未返回可解析的 JSON" } });
    await runOrThrow(h, "/mcp list");
    expect(h.replies[1]).toBe("❌ 获取 MCP 服务器状态失败: pi mcp list 未返回可解析的 JSON");
  });
});

describe("/mcp help 与未知子命令", () => {
  it("/mcp help → 专项帮助(含生效语义)", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp help");
    expect(h.replies[0]).toContain("登录即刻生效");
    expect(h.replies[0]).toContain("增删需 /reload 生效");
  });

  it("未知子命令 → 用法总览,编排槽零调用", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp frobnicate x");
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain("用法:");
    expect(h.listCalls).toBe(0);
    expect(h.addCalls).toHaveLength(0);
  });
});

describe("/mcp add", () => {
  it("--url 形态:argv 原样透传,成功回执带 /reload 生效提示 + 审计", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add docs --url https://mcp.example.com/mcp");
    expect(h.addCalls).toEqual([["docs", "--url", "https://mcp.example.com/mcp"]]);
    expect(h.replies[0]).toContain("已添加 MCP 服务器「docs」");
    expect(h.replies[0]).toContain("/reload 生效(多项目用 /reload all)");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpAdd, detail: "add docs" }]);
  });

  it("引号分词:带空格的服务器名与带空格的 URL", async () => {
    const h = harness();
    await runOrThrow(h, '/mcp add "my server" --url "https://x.example.com/a b"');
    expect(h.addCalls).toEqual([["my server", "--url", "https://x.example.com/a b"]]);
    expect(h.audits[0]?.detail).toBe("add my server");
  });

  it("`--` 命令段原样透传(-- 之后不再当 flag 解析)", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add fs -- npx -y server-fs /tmp --local --env FOO=1");
    expect(h.addCalls).toEqual([["fs", "--", "npx", "-y", "server-fs", "/tmp", "--local", "--env", "FOO=1"]]);
    // `--` 之后的 --local 是位置命令参数,不是 v1 拒绝的作用域 flag。
    expect(h.replies[0]).toContain("已添加 MCP 服务器「fs」");
  });

  it("pi 1.0 的 oauth/bearer 带值 flag 出现在名字前:值不被误当服务器名", async () => {
    const h = harness();
    await runOrThrow(
      h,
      "/mcp add --oauth-client-id cid-123 --oauth-client-secret sec-456 --oauth-callback-port 8976 " +
        "--bearer-token-env-var MCP_TOKEN --oauth-client-name 'My App' --url https://x.example.com/mcp corp",
    );
    // argv 原样透传给 pi(顺序与值都不动)。
    expect(h.addCalls[0]).toEqual([
      "--oauth-client-id", "cid-123",
      "--oauth-client-secret", "sec-456",
      "--oauth-callback-port", "8976",
      "--bearer-token-env-var", "MCP_TOKEN",
      "--oauth-client-name", "My App",
      "--url", "https://x.example.com/mcp",
      "corp",
    ]);
    // 回执与审计记的是真实服务器名,不是 flag 的值。
    expect(h.replies[0]).toContain("已添加 MCP 服务器「corp」");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpAdd, detail: "add corp" }]);
  });

  it("--local(v1 不提供)→ 专用拒绝回执,不发起编排", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add fs --local -- npx serve");
    expect(h.replies[0]).toBe("❌ 暂不支持 --local 作用域限定:请去掉该选项后重试。");
    expect(h.addCalls).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("缺服务器名 → 用法回执", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add --url https://x");
    expect(h.replies[0]).toContain("用法: /mcp add");
    expect(h.addCalls).toHaveLength(0);
  });

  it("无参数 → 用法回执", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add");
    expect(h.replies[0]).toContain("用法: /mcp add");
  });

  it("未闭合引号 → 用法 + 人话原因,不发起编排", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add fs --url \"https://x");
    expect(h.replies[0]).toContain("用法: /mcp add");
    expect(h.replies[0]).toContain("双引号没有闭合");
    expect(h.addCalls).toHaveLength(0);
  });

  it("失败回执脱敏:--env/--header 的值替换为 ***,不透传", async () => {
    const h = harness({
      add: { kind: "failed", message: 'invalid --env value "sk-secret-123" near "K=sk-secret-123"' },
    });
    await runOrThrow(h, "/mcp add corp --header 'X-Api: tok-abc-999' --env K=sk-secret-123 --url https://x");
    expect(h.replies[0]).toContain("添加 MCP 服务器失败");
    expect(h.replies[0]).not.toContain("sk-secret-123");
    expect(h.replies[0]).not.toContain("tok-abc-999");
    expect(h.replies[0]).toContain("***");
    expect(h.audits).toHaveLength(0); // 失败无突变,不落账
  });

  it("unavailable 回执同样脱敏:版本门诊断里的 --env 值也不透传", async () => {
    const h = harness({
      add: {
        kind: "unavailable",
        message: 'pi 不认识这条 mcp 子命令:model echoed --env K=sk-secret-123',
      },
    });
    await runOrThrow(h, "/mcp add corp --env K=sk-secret-123 --url https://x");
    expect(h.replies[0]).toContain("MCP 管理不可用");
    expect(h.replies[0]).not.toContain("sk-secret-123");
    expect(h.replies[0]).toContain("***");
    expect(h.audits).toHaveLength(0);
  });

  it("成功回执不透传 pi stdout(即使它包含 env 值)", async () => {
    const h = harness({ add: { kind: "ok", data: "Added corp (--env K=sk-secret-123)" } });
    await runOrThrow(h, "/mcp add corp --env K=sk-secret-123 --url https://x");
    expect(h.replies[0]).not.toContain("sk-secret-123");
    expect(h.replies[0]).toContain("已添加 MCP 服务器「corp」");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpAdd, detail: "add corp" }]);
  });

  it("confirmed=false(旧版 pi 当 prompt)→ 成功回执附降级提示,审计标 (unverified)", async () => {
    const h = harness({ add: { kind: "ok", data: "模型回复", confirmed: false } });
    await runOrThrow(h, "/mcp add corp --url https://x");
    expect(h.replies[0]).toContain("已添加 MCP 服务器「corp」");
    expect(h.replies[0]).toContain("未含预期的添加确认信息");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpAdd, detail: "add corp (unverified)" }]);
  });

  it("confirmed 缺省/true → 回执不带降级提示(纯函数缝不强制该字段)", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp add corp --url https://x");
    expect(h.replies[0]).not.toContain("未含预期的添加确认信息");
    const hTrue = harness({ add: { kind: "ok", data: "Added", confirmed: true } });
    await runOrThrow(hTrue, "/mcp add corp --url https://x");
    expect(hTrue.replies[0]).not.toContain("未含预期的添加确认信息");
    expect(hTrue.audits).toEqual([{ event: AUDIT_EVENTS.mcpAdd, detail: "add corp" }]);
  });
});

describe("/mcp remove 与 /mcp logout", () => {
  it("remove 成功:回执带 /reload 生效提示 + 审计 mcp.remove", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp remove corp");
    expect(h.removeCalls).toEqual(["corp"]);
    expect(h.replies[0]).toContain("已移除 MCP 服务器「corp」");
    expect(h.replies[0]).toContain("/reload 生效(多项目用 /reload all)");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpRemove, detail: "remove corp" }]);
  });

  it("remove 失败:诊断透传,不落账", async () => {
    const h = harness({ remove: { kind: "failed", message: 'no server named "corp"' } });
    await runOrThrow(h, "/mcp remove corp");
    expect(h.replies[0]).toBe('❌ 移除 MCP 服务器失败: no server named "corp"');
    expect(h.audits).toHaveLength(0);
  });

  it("remove 缺名 / 多余参数 → 用法回执,零调用", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp remove");
    expect(h.replies[0]).toContain("用法: /mcp remove");
    await runOrThrow(h, "/mcp remove a b");
    expect(h.replies[1]).toContain("用法: /mcp remove");
    expect(h.removeCalls).toHaveLength(0);
  });

  it("引号分词:带空格的服务器名可删掉/登出(与 add/login 同一口径)", async () => {
    const h = harness();
    await runOrThrow(h, '/mcp remove "my server"');
    expect(h.removeCalls).toEqual(["my server"]);
    expect(h.replies[0]).toContain("已移除 MCP 服务器「my server」");
    await runOrThrow(h, "/mcp logout 'my server'");
    expect(h.logoutCalls).toEqual(["my server"]);
    expect(h.replies[1]).toContain("已登出 MCP 服务器「my server」");
    expect(h.audits).toEqual([
      { event: AUDIT_EVENTS.mcpRemove, detail: "remove my server" },
      { event: AUDIT_EVENTS.mcpLogout, detail: "logout my server" },
    ]);
  });

  it("未闭合引号 → 用法 + 分词原因,零调用", async () => {
    const h = harness();
    await runOrThrow(h, '/mcp remove "my server');
    expect(h.replies[0]).toContain("用法: /mcp remove");
    expect(h.replies[0]).toContain("双引号没有闭合");
    expect(h.removeCalls).toHaveLength(0);
  });

  it("remove/logout confirmed=false → 降级提示 + 审计 (unverified)", async () => {
    const h = harness({
      remove: { kind: "ok", data: "模型回复", confirmed: false },
      logout: { kind: "ok", data: "模型回复", confirmed: false },
    });
    await runOrThrow(h, "/mcp remove corp");
    expect(h.replies[0]).toContain("未含预期的移除确认信息");
    await runOrThrow(h, "/mcp logout corp");
    expect(h.replies[1]).toContain("未含预期的登出确认信息");
    expect(h.audits).toEqual([
      { event: AUDIT_EVENTS.mcpRemove, detail: "remove corp (unverified)" },
      { event: AUDIT_EVENTS.mcpLogout, detail: "logout corp (unverified)" },
    ]);
  });

  it("logout 成功:回执 + 审计 mcp.logout", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp logout corp");
    expect(h.logoutCalls).toEqual(["corp"]);
    expect(h.replies[0]).toContain("已登出 MCP 服务器「corp」");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogout, detail: "logout corp" }]);
  });

  it("logout 失败:诊断透传,不落账", async () => {
    const h = harness({ logout: { kind: "failed", message: "not signed in" } });
    await runOrThrow(h, "/mcp logout corp");
    expect(h.replies[0]).toBe("❌ 登出 MCP 服务器失败: not signed in");
    expect(h.audits).toHaveLength(0);
  });
});

// ----------------------------------------------------------------登录编排

describe("/mcp login", () => {
  it("发起:执行缝收到 (server, 缺省 300s),回「发起中」;URL 行即时转发本房间", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    expect(h.loginCalls).toHaveLength(1);
    expect(h.loginCalls[0]).toMatchObject({ server: "corp", timeoutSec: 300 });
    expect(h.replies[0]).toContain('正在为 MCP 服务器「corp」发起登录');
    h.emit('Sign in to MCP server "corp" in your browser:');
    h.emit("https://auth.example.com/authorize?state=x");
    // URL 转发是异步回调,排空微任务后断言。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const urlReply = h.replies.find((r) => r.includes("https://auth.example.com/authorize?state=x"));
    expect(urlReply).toBeDefined();
    expect(urlReply).toContain("完成 MCP 服务器「corp」的授权");
    expect(urlReply).toContain("SSH"); // 回跳限制 + SSH 隧道提示
    expect(h.audits).toHaveLength(0); // 未终局不落账
  });

  it("成功(done.already=false):回执带「即刻生效,无需 /reload」+ 审计 mcp.login", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    h.emit('Signed in to MCP server "corp" (3 tools).');
    await h.finishLogin();
    expect(h.replies.at(-1)).toContain('MCP 服务器「corp」登录成功');
    expect(h.replies.at(-1)).toContain("即刻生效");
    // 登录不走增删的「发 /reload 生效」语义(文案是「无需 /reload」)。
    expect(h.replies.at(-1)).not.toContain("发 /reload 生效");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogin, detail: "login corp: signed in" }]);
  });

  it("本已登录:回执「无需重复」+ 审计区分 already", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    h.emit('Already signed in to MCP server "corp" (3 tools).');
    await h.finishLogin();
    expect(h.replies.at(-1)).toContain('「corp」本已登录,无需重复操作');
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogin, detail: "login corp: already signed in" }]);
  });

  it("失败(退出码 1):回执带退出码与诊断,审计 failed", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    await h.finishLogin({ code: 1, stderr: "Sign-in to MCP server corp failed: connection refused" });
    expect(h.replies.at(-1)).toContain('「corp」登录失败(退出码 1)');
    expect(h.replies.at(-1)).toContain("connection refused");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogin, detail: "login corp: failed (exit 1)" }]);
  });

  it("版本门(unavailable 结算,pi 缺失):回 unavailable 回执 + 审计 unavailable", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    await h.finishLogin({ code: undefined, unavailable: "无法定位 pi CLI:Cannot locate the pi CLI" });
    expect(h.replies.at(-1)).toContain("MCP 管理不可用");
    expect(h.replies.at(-1)).toContain("Cannot locate the pi CLI");
    expect(h.replies.at(-1)).toContain("pi ≥ 1.0");
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogin, detail: "login corp: unavailable" }]);
  });

  it("超时(timedOut):expired 回执带钳后秒数 + 审计 expired", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp --timeout 120");
    expect(h.loginCalls[0]?.timeoutSec).toBe(120);
    await h.finishLogin({ timedOut: true });
    expect(h.replies.at(-1)).toContain('「corp」登录超时(120s)');
    expect(h.audits).toEqual([{ event: AUDIT_EVENTS.mcpLogin, detail: "login corp: expired after 120s" }]);
  });

  it("--timeout 超上限 → 编排器钳到 600(编排器自钳,不依赖缝)", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp --timeout 99999");
    expect(h.loginCalls[0]?.timeoutSec).toBe(600);
  });

  it("单飞拒绝:在途时再发起 → busy 回执带在途服务器名,不产生第二次执行缝调用、不落账", async () => {
    const h = harness();
    await runOrThrow(h, "/mcp login corp");
    await runOrThrow(h, "/mcp login lab");
    expect(h.replies.at(-1)).toBe('⚠️ 已有登录进行中:「corp」。等它完成或超时后再发起下一次。');
    expect(h.loginCalls).toHaveLength(1);
    expect(h.audits).toHaveLength(0);
  });

  it("坏参数:未知 flag / 非数字 --timeout / 缺服务器名 / 多余参数 → 用法,零调用", async () => {
    for (const text of [
      "/mcp login",
      "/mcp login corp --fast",
      "/mcp login corp --timeout abc",
      "/mcp login corp --timeout",
      "/mcp login corp extra",
    ]) {
      const h = harness();
      await runOrThrow(h, text);
      expect(h.replies[0]).toContain("用法: /mcp login");
      expect(h.loginCalls).toHaveLength(0);
    }
  });
});

// ----------------------------------------------------------------真实装配形状

describe("createMcpOrchestration(真实装配)", () => {
  it("工厂产出四缝 + McpLoginFlow,槽形状满足命令层契约", async () => {
    const { createMcpOrchestration } = await import("../src/rpc/command-map");
    // resolveCliPath 注入固定路径:工厂调用短命令时不触真实解析链。
    const deps: McpCliDeps = {
      resolveCliPath: async () => "/fake/pi-cli.js",
      spawn: () => {
        throw new Error("测试不应触达真实 spawn");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const mcp = createMcpOrchestration(deps);
    expect(typeof mcp.list).toBe("function");
    expect(typeof mcp.add).toBe("function");
    expect(typeof mcp.remove).toBe("function");
    expect(typeof mcp.logout).toBe("function");
    expect(mcp.login).toBeInstanceOf(McpLoginFlow);
    // login 走的是注入的同一份 deps(此处 spawn 会抛 → 执行缝捕获为失败,
    // 恰好证明编排器消费了工厂传入的 deps)。
    const started = mcp.login.start("corp", undefined, {});
    if (started.kind !== "started") throw new Error("意外被拒:单飞槽应空闲");
    const outcome = await started.done;
    expect(outcome.kind).toBe("failed");
  });
});
