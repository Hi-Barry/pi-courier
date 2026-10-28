/**
 * /mcp 指令族纯函数三件的单测(spec #246):分词器、list --json 卡片、
 * 登录行解析器。全部直给字符串/假数据,不 spawn、不连网。
 * 钉住的 pi 1.0.0 文案 fixture 与 src/mcp/mcp-formatters.ts 头注释同源。
 */
import { describe, expect, it } from "vitest";
import { setLocale } from "../src/i18n/index.js";
import {
  createLoginLineParser,
  formatMcpStatusCard,
  parseMcpListJson,
  tokenizeChatArgs,
  type McpListPayload,
} from "../src/mcp/mcp-formatters.js";

describe("tokenizeChatArgs · 聊天文本分词", () => {
  it("常规分词:空白分隔,连续空白合并,首尾空白忽略", () => {
    expect(tokenizeChatArgs("add foo --url https://x.dev/mcp")).toEqual({
      ok: true,
      argv: ["add", "foo", "--url", "https://x.dev/mcp"],
    });
    expect(tokenizeChatArgs("  add   foo\t\nbar  ")).toEqual({
      ok: true,
      argv: ["add", "foo", "bar"],
    });
  });

  it("双引号保留空格成单 token;单引号一切字面(无转义)", () => {
    expect(tokenizeChatArgs('add "my server"')).toEqual({
      ok: true,
      argv: ["add", "my server"],
    });
    expect(tokenizeChatArgs("--description '它说: \"你好\" \\n 再见'")).toEqual({
      ok: true,
      argv: ["--description", '它说: "你好" \\n 再见'],
    });
  });

  it("双引号内只认 \\\\ 与 \\\" 两对转义;引号外反斜杠转义任一字符", () => {
    expect(tokenizeChatArgs('"a\\\\b\\"c"')).toEqual({ ok: true, argv: ['a\\b"c'] });
    // 双引号内 \n 不转义,反斜杠原样保留(POSIX sh 同判)。
    expect(tokenizeChatArgs('"K=a\\nb"')).toEqual({ ok: true, argv: ["K=a\\nb"] });
    expect(tokenizeChatArgs("add my\\ server")).toEqual({ ok: true, argv: ["add", "my server"] });
  });

  it("-- token 原样保留,其后 token 照常分词(引号不失效)——透传语义钉住", () => {
    expect(tokenizeChatArgs("add foo -- node srv.js --port 3000")).toEqual({
      ok: true,
      argv: ["add", "foo", "--", "node", "srv.js", "--port", "3000"],
    });
    expect(tokenizeChatArgs('add foo -- node "my srv.js"')).toEqual({
      ok: true,
      argv: ["add", "foo", "--", "node", "my srv.js"],
    });
  });

  it("空输入与纯空白 → ok 且 argv 为空(命令层据此给用法回执)", () => {
    expect(tokenizeChatArgs("")).toEqual({ ok: true, argv: [] });
    expect(tokenizeChatArgs("   \n\t ")).toEqual({ ok: true, argv: [] });
  });

  it("未闭合引号 → ok:false,error 指明是哪种引号;argv 保留已解析前缀", () => {
    const bad = tokenizeChatArgs('add "my server');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("双引号");
    expect(bad.argv).toEqual(["add"]);
    const badSingle = tokenizeChatArgs("add 'x");
    expect(badSingle.ok).toBe(false);
    expect(badSingle.error).toContain("单引号");
  });

  it("行尾孤反斜杠 → ok:false", () => {
    const bad = tokenizeChatArgs("add foo\\");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("反斜杠");
  });
});

/** pi 1.0.0 实测的 list --json 形状(connected 全字段),作为钉住 fixture。 */
const CONNECTED_SERVER = {
  name: "docs",
  scope: "global",
  source: "/root/.pi/agent/mcp.json",
  enabled: true,
  exposure: "codemode",
  transport: "https://docs.example.dev/mcp (streamable HTTP)",
  state: "connected",
  tools: ["search", "fetch"],
};

function payloadWith(servers: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ servers, errors: [], ...extra }, null, 2);
}

describe("parseMcpListJson · list --json 载荷解析", () => {
  it("pi 实测形状:connected 服务器全字段还原", () => {
    const payload = parseMcpListJson(payloadWith([CONNECTED_SERVER]));
    expect(payload).toBeDefined();
    expect(payload!.servers).toHaveLength(1);
    expect(payload!.servers[0]).toMatchObject({
      name: "docs",
      state: "connected",
      exposure: "codemode",
      scope: "global",
      transport: CONNECTED_SERVER.transport,
      tools: ["search", "fetch"],
    });
    expect(payload!.errors).toEqual([]);
  });

  it("真机空配置形状 {servers:[],errors:[]} → 空 servers 载荷", () => {
    const payload = parseMcpListJson('{"servers": [], "errors": []}');
    expect(payload).toEqual({ servers: [], errors: [] });
  });

  it("可选字段(toolExposure/resources/resourceTemplates/error/note)容缺容杂", () => {
    const payload = parseMcpListJson(
      JSON.stringify({
        servers: [
          {
            name: "corp",
            state: "connected",
            tools: ["a", 42, "b"], // 非字符串元素剔除
            toolExposure: { a: "direct", bad: 1 },
            resources: 3,
            resourceTemplates: 1,
          },
        ],
        errors: ["config error: bad json at ~/.pi/agent/mcp.json"],
        note: "project config ignored (untrusted)",
      }),
    );
    expect(payload!.servers[0]!.tools).toEqual(["a", "b"]);
    expect(payload!.servers[0]!.toolExposure).toEqual({ a: "direct" });
    expect(payload!.servers[0]!.resources).toBe(3);
    expect(payload!.errors).toEqual(["config error: bad json at ~/.pi/agent/mcp.json"]);
    expect(payload!.note).toBe("project config ignored (untrusted)");
  });

  it("非 JSON / 非对象 / 缺 servers 数组 → undefined(旧版 pi 喂模型的出口)", () => {
    expect(parseMcpListJson("not json at all")).toBeUndefined();
    expect(parseMcpListJson("42")).toBeUndefined();
    expect(parseMcpListJson('{"errors": []}')).toBeUndefined();
    expect(parseMcpListJson('{"servers": "nope"}')).toBeUndefined();
    // servers 条目缺 name 的剔除,不整体拒收。
    expect(parseMcpListJson('{"servers": [{"state": "connected"}, {"name": "ok"}]}')!.servers).toHaveLength(1);
  });
});

describe("formatMcpStatusCard · 状态卡渲染", () => {
  it("空列表 → 添加指引与 /reload 生效提示", () => {
    const card = formatMcpStatusCard({ servers: [], errors: [] });
    expect(card).toContain("尚未配置任何 MCP 服务器");
    expect(card).toContain("/mcp add <名> --url <地址>");
    expect(card).toContain("/mcp add <名> -- <命令> [参数...]");
    expect(card).toContain("/reload");
  });

  it("connected 服务器:name/state/tools/exposure/scope/transport 全进卡", () => {
    const payload = parseMcpListJson(payloadWith([CONNECTED_SERVER]))!;
    const card = formatMcpStatusCard(payload);
    expect(card).toContain("MCP 服务器(1)");
    expect(card).toContain("• docs — 已连接 | codemode | global");
    expect(card).toContain("传输:https://docs.example.dev/mcp (streamable HTTP)");
    expect(card).toContain("工具(2):search, fetch");
  });

  it("needs-auth 服务器:状态中文化并附 /mcp login 提示", () => {
    const payload = parseMcpListJson(
      payloadWith([{ name: "corp", state: "needs-auth", exposure: "codemode", scope: "global", tools: [] }]),
    )!;
    const card = formatMcpStatusCard(payload);
    expect(card).toContain("• corp — 待登录");
    expect(card).toContain("/mcp login corp");
  });

  it("enabled:false / disabled → 已禁用;未知 state 原样透传不猜", () => {
    const disabledFlag = parseMcpListJson(payloadWith([{ name: "a", enabled: false }]))!;
    expect(formatMcpStatusCard(disabledFlag)).toContain("• a — 已禁用");
    const disabledState = parseMcpListJson(payloadWith([{ name: "b", enabled: true, state: "disabled" }]))!;
    expect(formatMcpStatusCard(disabledState)).toContain("• b — 已禁用");
    const weird = parseMcpListJson(payloadWith([{ name: "c", enabled: true, state: "warp-drift" }]))!;
    expect(formatMcpStatusCard(weird)).toContain("• c — warp-drift");
  });

  it("工具超 8 个折叠为计数;逐服务器 error 单行截断", () => {
    const many = Array.from({ length: 11 }, (_, i) => `tool_${i}`);
    const longError = "x".repeat(500);
    const payload = parseMcpListJson(
      payloadWith([{ name: "big", state: "failed", tools: many, error: longError }]),
    )!;
    const card = formatMcpStatusCard(payload);
    expect(card).toContain("工具(11):tool_0, tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7 …等 11 个");
    // 错误被截断(… 标记)且压成单行。
    expect(card).toMatch(/⚠ x+…/);
    expect(card).not.toContain("x".repeat(300));
  });

  it("顶层 errors 进「配置错误」段且截断;note 进「注」", () => {
    const payload = parseMcpListJson(
      JSON.stringify({
        servers: [],
        errors: [`config error: ${"y".repeat(500)}`],
        note: "untrusted project ignored",
      }),
    )!;
    const card = formatMcpStatusCard(payload);
    expect(card).toContain("配置错误:");
    expect(card).toMatch(/• config error: y+…/);
    expect(card).toContain("注:untrusted project ignored");
  });

  it("多服务器逐行排列(部分失败不误报成全失败的展示基础)", () => {
    const payload = parseMcpListJson(
      payloadWith([
        CONNECTED_SERVER,
        { name: "corp", state: "needs-auth", tools: [] },
        { name: "down", state: "connected", error: "connect ECONNREFUSED" },
      ]),
    )!;
    const card = formatMcpStatusCard(payload as McpListPayload);
    expect(card).toContain("MCP 服务器(3)");
    expect(card).toContain("• docs — 已连接");
    expect(card).toContain("• corp — 待登录");
    expect(card).toContain("• down — 已连接");
    expect(card).toContain("ECONNREFUSED");
  });

  it("i18n:en 部署的状态卡走英文(状态标签/骨架/空列表指引均经双表)", () => {
    setLocale("en");
    try {
      const payload = parseMcpListJson(
        payloadWith([
          { name: "docs", state: "connected", tools: ["search"] },
          { name: "corp", state: "needs-auth", tools: [] },
        ]),
      )!;
      const card = formatMcpStatusCard(payload);
      expect(card).toContain("MCP servers (2):");
      expect(card).toContain("• docs — connected");
      expect(card).toContain("• corp — needs auth");
      expect(card).toContain("sign-in required");
      expect(card).toContain("tools (1): search");
      expect(card).not.toContain("已连接");
      expect(formatMcpStatusCard({ servers: [], errors: [] })).toContain(
        "No MCP servers configured yet.",
      );
    } finally {
      setLocale("zh"); // tests/setup.ts 的全局锚是 zh
    }
  });

  it("i18n:en 部署的分词错误走英文(经 add/remove 用法回执进聊天)", () => {
    setLocale("en");
    try {
      const badDouble = tokenizeChatArgs('add "my server');
      expect(badDouble.ok).toBe(false);
      expect(badDouble.error).toBe("A double quote is not closed");
      expect(tokenizeChatArgs("add 'x").error).toBe("A single quote is not closed");
      expect(tokenizeChatArgs("add foo\\").error).toBe("A backslash has no following character");
    } finally {
      setLocale("zh");
    }
  });
});

describe("createLoginLineParser · 登录 stdout 行解析", () => {
  it("钉住的 pi 文案:browser 提示行的下一行 URL → auth-url", () => {
    const parse = createLoginLineParser();
    expect(parse('Sign in to MCP server "corp" in your browser:')).toEqual({
      kind: "raw",
      text: 'Sign in to MCP server "corp" in your browser:',
    });
    expect(parse("https://auth.example.com/authorize?state=xyz")).toEqual({
      kind: "auth-url",
      url: "https://auth.example.com/authorize?state=xyz",
    });
  });

  it("容错漂移:URL 与提示同行时直接取行内 URL", () => {
    const parse = createLoginLineParser();
    expect(parse("Open https://auth.example.com/x in your browser:")).toEqual({
      kind: "auth-url",
      url: "https://auth.example.com/x",
    });
  });

  it("Already signed in 行 → already-signed-in;不得误中成功行判定", () => {
    const parse = createLoginLineParser();
    expect(parse('Already signed in to MCP server "corp" (3 tools).')).toEqual({
      kind: "already-signed-in",
    });
  });

  it("Signed in to MCP server 行 → signed-in(成功收尾)", () => {
    const parse = createLoginLineParser();
    expect(parse('Signed in to MCP server "corp" (3 tools).')).toEqual({ kind: "signed-in" });
  });

  it("失败与取消文案、普通行 → raw 原文透传(降级不编造)", () => {
    const parse = createLoginLineParser();
    const failed = 'Sign-in to MCP server "corp" failed: connect ECONNREFUSED';
    expect(parse(failed)).toEqual({ kind: "raw", text: failed });
    const cancelled = 'Sign-in to MCP server "corp" was cancelled or not completed within 300 seconds.';
    expect(parse(cancelled)).toEqual({ kind: "raw", text: cancelled });
    expect(parse("some random output")).toEqual({ kind: "raw", text: "some random output" });
    expect(parse("")).toEqual({ kind: "raw", text: "" });
  });

  it("URL 行仅在 browser 提示之后才算 auth-url;提示后跟非 URL 行则不再等待", () => {
    const parse = createLoginLineParser();
    parse('Sign in to MCP server "corp" in your browser:');
    // 提示行后是文案而非 URL:该行走 raw,且 pending 清空。
    expect(parse("waiting for redirect...").kind).toBe("raw");
    expect(parse("https://unrelated.example.com/feed").kind).toBe("raw");
  });
});
