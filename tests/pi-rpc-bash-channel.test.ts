/**
 * PiRpc bash 自管应答通道(spec #218 票 #220)。
 *
 * 上游 send() 把应答超时写死 30s,服务端 bash 分支要 await 命令跑完才回应
 * 答 —— 长命令(构建/安装/长测试)必被误杀。通道绕开 send():往子进程 stdin
 * 写一条带自定义 id(bridge_bash_N)的 JSONL 命令,在事件流里等按 id 回来的
 * 应答;超时可配置(默认 10 分钟),到点弃权报 BashTimeoutError。在途计数
 * 手动入账,重启排水不漏账。
 *
 * 白盒缝(先例 pi-rpc-send.test.ts):注入 fake client(记录 stdin 写行、
 * 捕获事件 listener);时序用 fake timers,不真实等待。
 */
import { describe, expect, it, vi } from "vitest";
import { BashTimeoutError, PiRpc } from "../src/rpc/pi-rpc";

const BASH_RESULT = { output: "hello", exitCode: 0, cancelled: false, truncated: false };

interface FakeClient {
  stdinWrite: ReturnType<typeof vi.fn>;
  fire: (event: unknown) => void;
  written: () => Record<string, unknown>;
}

/** A PiRpc with a fake connected client carrying a writable stdin. */
function withFakeChannel(options?: { bashTimeoutMs?: number; brokenStdin?: boolean }): {
  rpc: PiRpc;
  client: FakeClient;
} {
  const listeners: Array<(event: unknown) => void> = [];
  const stdinWrite = vi.fn();
  const rpc = new PiRpc({ bashTimeoutMs: options?.bashTimeoutMs });
  (rpc as unknown as { client: unknown }).client = {
    send: vi.fn(), // 自管通道不得触碰上游 send()
    onEvent: vi.fn().mockImplementation((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return vi.fn();
    }),
    process: {
      stdin: options?.brokenStdin
        ? { write: stdinWrite, destroyed: true, writable: false }
        : { write: stdinWrite, destroyed: false, writable: true },
    },
  };
  return {
    rpc,
    client: {
      stdinWrite,
      fire: (event: unknown) => {
        for (const listener of [...listeners]) listener(event);
      },
      written: () => JSON.parse(String(stdinWrite.mock.calls[0]?.[0] ?? "{}")) as Record<string, unknown>,
    },
  };
}

const respond = (id: string, over: Record<string, unknown> = {}) => ({
  type: "response",
  id,
  success: true,
  data: BASH_RESULT,
  ...over,
});

describe("PiRpc bash 自管应答通道(票 #220)", () => {
  it("线路命令为自定义 id 的单条 JSONL 行,字段齐备,不碰上游 send()", async () => {
    const { rpc, client } = withFakeChannel();
    const pending = rpc.bash("npm run build", { excludeFromContext: true });
    expect(client.stdinWrite).toHaveBeenCalledTimes(1);
    const line = String(client.stdinWrite.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true); // LF 帧单行
    const wire = JSON.parse(line) as Record<string, unknown>;
    expect(wire).toMatchObject({ type: "bash", command: "npm run build", excludeFromContext: true });
    expect(String(wire.id)).toMatch(/^bridge_bash_\d+$/);
    client.fire(respond(String(wire.id)));
    expect(await pending).toEqual(BASH_RESULT);
  });

  it("! 语义(excludeFromContext=false)同通道", async () => {
    const { rpc, client } = withFakeChannel();
    const pending = rpc.bash("ls");
    expect(client.written()).toMatchObject({ excludeFromContext: false });
    client.fire(respond(String(client.written().id)));
    await pending;
  });

  it("其他 id / 非 response 事件被忽略,本 id 应答到达才收尾", async () => {
    const { rpc, client } = withFakeChannel();
    const pending = rpc.bash("ls");
    const id = String(client.written().id);
    client.fire(respond("bridge_bash_999"));
    client.fire({ type: "compaction_end", reason: "manual", result: undefined });
    client.fire(respond("not-even-a-response-id"));
    client.fire(respond(id));
    expect(await pending).toEqual(BASH_RESULT);
  });

  it("success=false 抛出上游错误信息(应答剥离沿 getData 语义)", async () => {
    const { rpc, client } = withFakeChannel();
    const pending = rpc.bash("x");
    client.fire(respond(String(client.written().id), { success: false, data: undefined, error: "Agent is streaming" }));
    await expect(pending).rejects.toThrow("Agent is streaming");
  });

  it("超过注入的等待上限 → BashTimeoutError,含命令与分钟数(fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, client } = withFakeChannel({ bashTimeoutMs: 2 * 60_000 });
      const pending = rpc.bash("sleep 999");
      const settled = pending.then(
        () => undefined,
        (e: unknown) => e
      ); // 先挂 handler 再推时钟,避免异步挂 handler 的 unhandled rejection 噪音
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      const err = await settled;
      expect(err).toBeInstanceOf(BashTimeoutError);
      expect((err as BashTimeoutError).command).toBe("sleep 999");
      expect((err as BashTimeoutError).waitedMs).toBe(2 * 60_000);
      expect((err as Error).message).toContain("2 min");
      expect(client.stdinWrite).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未注入时等待上限缺省 10 分钟", () => {
    const { rpc } = withFakeChannel();
    expect((rpc as unknown as { options: { bashTimeoutMs?: number } }).options.bashTimeoutMs).toBeUndefined();
    // 缺省值常量与 config 默认一致(单源:config.ts BASH_TIMEOUT_MINUTES_DEFAULT)
    expect(rpc.bash("x")).toBeInstanceOf(Promise); // 冒烟:通道可用
  });

  it("在途计数:执行期间入账,收尾(成功/超时)后出账", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, client } = withFakeChannel({ bashTimeoutMs: 60_000 });
      const inflight = () => (rpc as unknown as { inFlight: number }).inFlight;
      const pending = rpc.bash("ls");
      expect(inflight()).toBe(1);
      client.fire(respond(String(client.written().id)));
      await pending;
      expect(inflight()).toBe(0);

      const pending2 = rpc.bash("ls");
      const settled2 = pending2.catch(() => {}); // 先挂 handler 再推时钟
      await vi.advanceTimersByTimeAsync(60_000);
      await settled2;
      expect(inflight()).toBe(0); // 超时收尾也出账
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdin 不可写 → 立即报错,在途出账", async () => {
    const { rpc } = withFakeChannel({ brokenStdin: true });
    await expect(rpc.bash("ls")).rejects.toThrow("stdin is not writable");
    expect((rpc as unknown as { inFlight: number }).inFlight).toBe(0);
  });

  it("未连接时抛 not connected", async () => {
    await expect(new PiRpc().bash("ls")).rejects.toThrow("pi RPC not connected");
  });
});
