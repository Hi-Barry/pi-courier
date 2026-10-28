/**
 * McpLoginFlow 登录编排器的单测(spec #246):全部经注入的假 runLogin 完成,
 * 不跑真实 pi、不连外部服务器。断言重点:同步 CAS 占位与并发拒绝、授权 URL
 * 即时上抛与 urlSent→waiting 转移、结算三分支(成功区分「新登录」与「本已
 * 登录」、失败带尾部、超时 expired)、timeoutSec 钳制、代次作废(迟到行/
 * 迟到收尾不写回状态、不发回执、结算 invalidated)。
 * 行解析用真实的 createLoginLineParser(同时锚定与 mcp-formatters 的对接)。
 */
import { describe, expect, it, vi } from "vitest";
import type { McpLoginResult } from "../src/mcp/mcp-cli.js";
import { McpLoginFlow, type McpLoginHooks, type McpLoginOutcome } from "../src/mcp/mcp-login-flow.js";

// ----------------------------------------------------------------假件基建

/** 假执行缝的一次调用(挂起中的流)。 */
interface PendingCall {
  server: string;
  timeoutSec: number;
  onLine: (line: string) => void;
  resolve: (result: McpLoginResult) => void;
}

interface Harness {
  flow: McpLoginFlow;
  calls: PendingCall[];
  /** 给最近一条流上抛一行 stdout(模拟 pi 输出)。 */
  emit(line: string): void;
  /** 让最近一条流的执行缝收尾(模拟进程退出;缺省正常退出 0)。 */
  finish(partial?: Partial<McpLoginResult>): void;
}

function harness(): Harness {
  const calls: PendingCall[] = [];
  const runLogin = (
    server: string,
    timeoutSec: number,
    onLine: (line: string) => void,
  ): Promise<McpLoginResult> =>
    new Promise<McpLoginResult>((resolve) => {
      calls.push({ server, timeoutSec, onLine, resolve });
    });
  const flow = new McpLoginFlow({
    runLogin,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return {
    flow,
    calls,
    emit: (line) => {
      calls.at(-1)!.onLine(line);
    },
    finish: (partial: Partial<McpLoginResult> = {}) => {
      calls.at(-1)!.resolve({ code: 0, timedOut: false, stdout: "", stderr: "", ...partial });
    },
  };
}

/** 收集终局回执的 hooks。 */
function finishedCollector(sink: McpLoginOutcome[]): { onFinished: (o: McpLoginOutcome) => void } {
  return { onFinished: (outcome) => sink.push(outcome) };
}

/** 发起并断言未被拒(测试语义:不该 busy 的路径直接炸出来)。 */
function startOrThrow(
  flow: McpLoginFlow,
  server: string,
  timeoutSec: number | undefined,
  hooks: McpLoginHooks = {},
): { kind: "started"; done: Promise<McpLoginOutcome> } {
  const started = flow.start(server, timeoutSec, hooks);
  if (started.kind !== "started") throw new Error(`意外被拒:${JSON.stringify(started)}`);
  return started;
}

const URL_PROMPT = 'Sign in to MCP server "corp" in your browser:';
const AUTH_URL = "https://auth.example.com/authorize?state=x";
const SIGNED_IN_LINE = 'Signed in to MCP server "corp" (3 tools).';
const ALREADY_LINE = 'Already signed in to MCP server "corp" (3 tools).';

// ----------------------------------------------------------------单飞占位

describe("单飞占位与并发拒绝", () => {
  it("start 同步占位(零 await):返回即 urlSent,执行缝收到 (server, 钳后秒数)", () => {
    const h = harness();
    const started = startOrThrow(h.flow, "corp", 300);
    expect(started.kind).toBe("started");
    expect(h.flow.currentState).toBe("urlSent");
    expect(h.flow.busyServer).toBe("corp");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ server: "corp", timeoutSec: 300 });
  });

  it("在途时第二次 start → busy(带在途服务器名),不产生第二次执行缝调用", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const first = startOrThrow(h.flow, "corp", 300, finishedCollector(sink));
    expect(h.flow.start("lab", 300)).toEqual({ kind: "busy", server: "corp" });
    expect(h.calls).toHaveLength(1);
    // 第一条流不受影响,照常结算并归位。
    h.emit(SIGNED_IN_LINE);
    h.finish();
    expect(await first.done).toEqual({ kind: "done", server: "corp", already: false });
    expect(h.flow.currentState).toBe("idle");
  });

  it("结算归位 idle 后可立即再次发起(状态机不留悬挂)", async () => {
    const h = harness();
    const first = startOrThrow(h.flow, "corp", 300);
    h.emit(ALREADY_LINE);
    h.finish();
    await first.done;
    expect(h.flow.currentState).toBe("idle");
    const second = h.flow.start("corp", 300);
    expect(second.kind).toBe("started");
    expect(h.flow.currentState).toBe("urlSent");
  });
});

// ----------------------------------------------------------------URL 转发

describe("授权 URL 即时上抛与状态转移", () => {
  it("URL 行解析出来立即调 onAuthUrl;转发落定前仍 urlSent,落定后转 waiting", async () => {
    const h = harness();
    const seen: Array<{ url: string; server: string }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startOrThrow(h.flow, "corp", 300, {
      onAuthUrl: async (url, server) => {
        seen.push({ url, server });
        await gate;
      },
    });
    expect(started.kind).toBe("started");
    expect(h.flow.currentState).toBe("urlSent");
    // 提示行(无 URL)不触发转发。
    h.emit(URL_PROMPT);
    expect(seen).toEqual([]);
    // URL 行(提示行的下一行)触发即时转发。
    h.emit(AUTH_URL);
    await Promise.resolve(); // 让 deliverUrl 跑进 onAuthUrl
    expect(seen).toEqual([{ url: AUTH_URL, server: "corp" }]);
    expect(h.flow.currentState).toBe("urlSent"); // 转发未落定,不提前转 waiting
    release();
    await vi.waitFor(() => expect(h.flow.currentState).toBe("waiting"));
    // 等回跳期间的收尾照常结算。
    h.emit(SIGNED_IN_LINE);
    h.finish();
    expect(await started.done).toEqual({ kind: "done", server: "corp", already: false });
  });

  it("未识别行(含提示行)经 onRawLine 原文透传", () => {
    const h = harness();
    const raw: string[] = [];
    h.flow.start("corp", 300, { onRawLine: (line) => raw.push(line) });
    h.emit(URL_PROMPT);
    h.emit("Waiting for browser authorization…");
    h.emit(SIGNED_IN_LINE);
    expect(raw).toEqual([URL_PROMPT, "Waiting for browser authorization…"]);
  });

  it("URL 行出现两次只转发一次(第二次已 waiting,不重复上抛)", async () => {
    const h = harness();
    const seen: string[] = [];
    const started = startOrThrow(h.flow, "corp", 300, {
      onAuthUrl: (url) => {
        seen.push(url);
      },
    });
    h.emit(URL_PROMPT);
    h.emit(AUTH_URL);
    h.emit(AUTH_URL);
    await vi.waitFor(() => expect(h.flow.currentState).toBe("waiting"));
    h.finish();
    await started.done;
    expect(seen).toEqual([AUTH_URL]);
  });

  it("同一批 stdout 内两组「提示行+URL 行」:转发未落定也去重,链接仍只上抛一次", async () => {
    const h = harness();
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startOrThrow(h.flow, "corp", 300, {
      onAuthUrl: async (url) => {
        seen.push(url);
        await gate; // 第一组转发挂起:状态位仍是 urlSent
      },
    });
    const secondUrl = "https://auth.example.com/authorize?state=y";
    h.emit(URL_PROMPT);
    h.emit(AUTH_URL);
    h.emit(URL_PROMPT);
    h.emit(secondUrl);
    await Promise.resolve();
    // 第一组转发尚未落定,第二组不得穿过预检重复上抛。
    expect(seen).toEqual([AUTH_URL]);
    release();
    await vi.waitFor(() => expect(h.flow.currentState).toBe("waiting"));
    h.finish();
    await started.done;
    expect(seen).toEqual([AUTH_URL]);
  });
});

// ----------------------------------------------------------------结算分支

describe("结算:成功 / 失败 / 超时", () => {
  it("signed-in 行 + 退出 0 → done(already=false),onFinished 收到,归位 idle", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const started = startOrThrow(h.flow, "corp", 300, finishedCollector(sink));
    h.emit(URL_PROMPT);
    h.emit(AUTH_URL);
    h.emit(SIGNED_IN_LINE);
    h.finish({ stdout: `${SIGNED_IN_LINE}\n` });
    expect(await started.done).toEqual({ kind: "done", server: "corp", already: false });
    expect(sink).toEqual([{ kind: "done", server: "corp", already: false }]);
    expect(h.flow.currentState).toBe("idle");
    expect(h.flow.busyServer).toBeUndefined();
  });

  it("already-signed-in 行 + 退出 0 → done(already=true):「本已登录」与新登录区分", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const started = startOrThrow(h.flow, "corp", 300, finishedCollector(sink));
    h.emit(ALREADY_LINE);
    h.finish();
    expect(await started.done).toEqual({ kind: "done", server: "corp", already: true });
    expect(sink).toEqual([{ kind: "done", server: "corp", already: true }]);
  });

  it("非零退出 → failed(message 带 stderr 尾部,code 保留)", async () => {
    const h = harness();
    const started = startOrThrow(h.flow, "corp", 300);
    h.finish({ code: 1, stderr: 'Sign-in to MCP server "corp" failed: HTTP 403' });
    const outcome = await started.done;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.server).toBe("corp");
      expect(outcome.code).toBe(1);
      expect(outcome.message).toContain("HTTP 403");
    }
    expect(h.flow.currentState).toBe("idle");
  });

  it("退出 0 但无成功标记(黑箱/文案漂移)→ failed(message 带输出尾部)", async () => {
    const h = harness();
    const started = startOrThrow(h.flow, "corp", 300);
    h.finish({ code: 0, stdout: "Some unrelated output" });
    const outcome = await started.done;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.code).toBe(0);
      expect(outcome.message).toContain("Some unrelated output");
    }
  });

  it("spawn 失败(spawnError)→ failed(message 含无法启动原因,code undefined)", async () => {
    const h = harness();
    const started = startOrThrow(h.flow, "corp", 300);
    h.finish({ spawnError: "spawn ENOENT", code: undefined });
    const outcome = await started.done;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.code).toBeUndefined();
      expect(outcome.message).toContain("无法启动 pi CLI");
      expect(outcome.message).toContain("spawn ENOENT");
    }
  });

  it("执行缝报 unavailable(pi 入口解析失败)→ 结算 unavailable(版本门),不结成 failed", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const started = startOrThrow(h.flow, "corp", 300, finishedCollector(sink));
    h.finish({ code: undefined, unavailable: "无法定位 pi CLI:Cannot locate the pi CLI" });
    const expected = {
      kind: "unavailable",
      server: "corp",
      message: "无法定位 pi CLI:Cannot locate the pi CLI",
    } as const;
    expect(await started.done).toEqual(expected);
    expect(sink).toEqual([expected]);
    expect(h.flow.currentState).toBe("idle");
    expect(h.flow.busyServer).toBeUndefined();
  });

  it("执行缝兜底 SIGKILL(timedOut)→ expired(timeoutSec 为钳后值),归位 idle", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const started = startOrThrow(h.flow, "corp", 700, finishedCollector(sink)); // 700 钳到 600
    h.finish({ timedOut: true, code: undefined });
    const outcome = await started.done;
    expect(outcome).toEqual({ kind: "expired", server: "corp", timeoutSec: 600 });
    expect(sink).toEqual([{ kind: "expired", server: "corp", timeoutSec: 600 }]);
    expect(h.flow.currentState).toBe("idle");
  });

  it("onFinished 抛错只留痕:状态照常归位,done 照常结算", async () => {
    const h = harness();
    const started = startOrThrow(h.flow, "corp", 300, {
      onFinished: () => {
        throw new Error("send failed");
      },
    });
    h.emit(SIGNED_IN_LINE);
    h.finish();
    expect(await started.done).toEqual({ kind: "done", server: "corp", already: false });
    expect(h.flow.currentState).toBe("idle");
  });
});

// ----------------------------------------------------------------超时钳制

describe("timeoutSec 钳制(桥侧硬上限 600s,缺省 300s)", () => {
  it.each([
    ["700(超上限)→ 600", 700, 600],
    ["600(恰等于上限)→ 600", 600, 600],
    ["undefined(未指定)→ 300", undefined, 300],
    ["0(非法)→ 300", 0, 300],
    ["-5(非法)→ 300", -5, 300],
    ["NaN(非法)→ 300", Number.NaN, 300],
  ] as const)("%s", (_label, input, expected) => {
    const h = harness();
    const started = h.flow.start("corp", input);
    expect(started.kind).toBe("started");
    expect(h.calls[0]!.timeoutSec).toBe(expected);
  });
});

// ----------------------------------------------------------------代次作废

describe("代次栅栏:invalidate 与迟到写回", () => {
  it("invalidate:在途流即刻归位 idle,可立即再次发起", () => {
    const h = harness();
    h.flow.start("corp", 300);
    h.flow.invalidate("bridge restart");
    expect(h.flow.currentState).toBe("idle");
    expect(h.flow.busyServer).toBeUndefined();
    const second = h.flow.start("lab", 300);
    expect(second.kind).toBe("started");
  });

  it("invalidate 于 idle 为无害 no-op,代次推进不影响后续流", () => {
    const h = harness();
    h.flow.invalidate("nothing in flight");
    expect(h.flow.currentState).toBe("idle");
    const started = startOrThrow(h.flow, "corp", 300);
    h.emit(SIGNED_IN_LINE);
    h.finish();
    return expect(started.done).resolves.toEqual({ kind: "done", server: "corp", already: false });
  });

  it("旧流迟到收尾:不写回状态、不发回执、结算 invalidated;新流照常走完全程", async () => {
    const h = harness();
    const sink: McpLoginOutcome[] = [];
    const first = startOrThrow(h.flow, "corp", 300, finishedCollector(sink));
    h.flow.invalidate("bridge restart");
    const second = startOrThrow(h.flow, "lab", 300, finishedCollector(sink));
    expect(h.flow.currentState).toBe("urlSent"); // 新流占位中

    // 旧流迟到的成功行与正常退出(代次已作废)。
    h.calls[0]!.onLine(SIGNED_IN_LINE);
    h.calls[0]!.resolve({ code: 0, timedOut: false, stdout: SIGNED_IN_LINE, stderr: "" });
    expect(await first.done).toEqual({ kind: "invalidated", server: "corp" });
    // 旧流没碰状态机:新流仍占位,旧流的 onFinished 未被调用。
    expect(h.flow.currentState).toBe("urlSent");
    expect(sink).toEqual([]);

    // 新流照常走完全程。
    h.calls[1]!.onLine('Signed in to MCP server "lab" (1 tool).');
    h.calls[1]!.resolve({ code: 0, timedOut: false, stdout: "signed", stderr: "" });
    expect(await second.done).toEqual({ kind: "done", server: "lab", already: false });
    expect(sink).toEqual([{ kind: "done", server: "lab", already: false }]);
    expect(h.flow.currentState).toBe("idle");
  });

  it("旧流迟到的授权 URL 行不再上抛(整流已死,零副作用)", async () => {
    const h = harness();
    const seen: string[] = [];
    const first = startOrThrow(h.flow, "corp", 300, {
      onAuthUrl: (url) => {
        seen.push(url);
      },
    });
    h.flow.invalidate("bridge restart");
    h.calls[0]!.onLine(URL_PROMPT);
    h.calls[0]!.onLine(AUTH_URL);
    await Promise.resolve();
    expect(seen).toEqual([]);
    h.calls[0]!.resolve({ code: 0, timedOut: false, stdout: "", stderr: "" });
    expect(await first.done).toEqual({ kind: "invalidated", server: "corp" });
  });

  it("旧流迟到的超时收尾同样作废(SIGKILL 与 close 竞态互斥)", async () => {
    const h = harness();
    const first = startOrThrow(h.flow, "corp", 300);
    h.flow.invalidate("bridge restart");
    h.calls[0]!.resolve({ code: undefined, timedOut: true, stdout: "", stderr: "" });
    expect(await first.done).toEqual({ kind: "invalidated", server: "corp" });
    expect(h.flow.currentState).toBe("idle");
  });
});
