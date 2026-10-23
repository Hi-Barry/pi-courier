/**
 * PiRpc.compact 双源等待(spec #218 票 #219)。
 *
 * 上游 send() 把应答超时写死 30s 且迟到的应答被静默丢弃,慢压缩走旧路径
 * 必然「假失败」。compact() 改从两条通道收结果:RPC 应答(快路径)与
 * compaction_end 事件(慢路径),先到先赢;30s Timeout reject 被吞;aborted
 * 事件不收尾;reason 非 manual 被忽略;重启与兜底超时以中断收尾。
 *
 * 白盒缝(先例 pi-rpc-send.test.ts):注入 fake client,手动触发捕获到的
 * 事件 listener;时序用 fake timers 推进,不真实等待。
 */
import { describe, expect, it, vi } from "vitest";
import { COMPACT_WAIT_TIMEOUT_MS, PiRpc } from "../src/rpc/pi-rpc";

const COMPACTION_RESULT = { tokensBefore: 12345, summary: "压缩摘要", estimatedTokensAfter: 2345 };

interface FakeClient {
  compact: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  fire: (event: unknown) => void;
  unsub: ReturnType<typeof vi.fn>;
}

/** A PiRpc with a fake connected client; captured listeners fire via client.fire(). */
function withFakeClient(compactImpl?: () => Promise<unknown>): { rpc: PiRpc; client: FakeClient } {
  const listeners: Array<(event: unknown) => void> = [];
  const unsub = vi.fn();
  const client = {
    compact: vi.fn().mockImplementation(compactImpl ?? (() => Promise.resolve(COMPACTION_RESULT))),
    onEvent: vi.fn().mockImplementation((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return unsub;
    }),
    listeners,
    fire: (event: unknown) => {
      for (const listener of [...listeners]) listener(event);
    },
    unsub,
  };
  const rpc = new PiRpc();
  (rpc as unknown as { client: unknown }).client = client;
  return { rpc, client };
}

const compactionEnd = (over: Record<string, unknown> = {}) => ({
  type: "compaction_end",
  reason: "manual",
  result: COMPACTION_RESULT,
  aborted: false,
  willRetry: false,
  ...over,
});

describe("PiRpc.compact 双源等待(票 #219)", () => {
  it("快路径:应答先到 → ok + 应答结果,事件迟到不再收尾", async () => {
    const { rpc, client } = withFakeClient();
    const outcomePromise = rpc.compact();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: "ok", result: COMPACTION_RESULT });
    // 迟到事件(慢路径通道)不得改变已定的结果
    client.fire(compactionEnd({ result: { tokensBefore: 1, summary: "x" } }));
    expect(client.unsub).toHaveBeenCalled();
    expect(await outcomePromise).toEqual({ kind: "ok", result: COMPACTION_RESULT });
  });

  it("慢路径:应答 30s Timeout reject 被吞,compaction_end 事件收尾 ok", async () => {
    const { rpc, client } = withFakeClient(
      () => new Promise((_, reject) => reject(new Error("Timeout waiting for response to compact. Stderr: ")))
    );
    const outcomePromise = rpc.compact();
    await Promise.resolve(); // 让 reject 分支跑完(catch 吞掉)
    client.fire(compactionEnd());
    expect(await outcomePromise).toEqual({ kind: "ok", result: COMPACTION_RESULT });
  });

  it("事件带 errorMessage → failed + 原始消息", async () => {
    const { rpc, client } = withFakeClient(() => new Promise(() => {}));
    const outcomePromise = rpc.compact();
    client.fire(compactionEnd({ result: undefined, errorMessage: "Compaction failed: model exploded" }));
    expect(await outcomePromise).toEqual({ kind: "failed", message: "Compaction failed: model exploded" });
  });

  it("事件 result 缺失(旧版对端)且无 error → ok + result=undefined 降级", async () => {
    const { rpc, client } = withFakeClient(() => new Promise(() => {}));
    const outcomePromise = rpc.compact();
    client.fire(compactionEnd({ result: undefined }));
    expect(await outcomePromise).toEqual({ kind: "ok", result: undefined });
  });

  it("aborted 事件(被后继压缩打断/extension 取消)→ interrupted:aborted", async () => {
    const { rpc, client } = withFakeClient(() => new Promise(() => {}));
    const outcomePromise = rpc.compact();
    client.fire(compactionEnd({ aborted: true, result: undefined }));
    expect(await outcomePromise).toEqual({ kind: "interrupted", reason: "aborted" });
  });

  it("应答即时失败(非 Timeout,如 Already compacted)→ 立即 failed,不等事件/兜底", async () => {
    const { rpc, client } = withFakeClient(
      () => new Promise((_, reject) => reject(new Error("Already compacted")))
    );
    const outcomePromise = rpc.compact();
    expect(await outcomePromise).toEqual({ kind: "failed", message: "Already compacted" });
    // 迟到事件不得改变已定的结果
    client.fire(compactionEnd({ result: undefined, errorMessage: "Compaction failed: Already compacted" }));
    expect(await outcomePromise).toEqual({ kind: "failed", message: "Already compacted" });
  });

  it("reason 非 manual(自动压缩)的事件被忽略", async () => {
    vi.useFakeTimers();
    try {
      const { rpc, client } = withFakeClient(() => new Promise(() => {}));
      const outcomePromise = rpc.compact();
      client.fire(compactionEnd({ reason: "threshold", result: { tokensBefore: 0, summary: "auto" } }));
      client.fire(compactionEnd({ reason: "overflow", result: undefined, errorMessage: "auto boom" }));
      // 两类事件都不收尾 —— 兜底超时仍是唯一收尾路径
      await vi.advanceTimersByTimeAsync(COMPACT_WAIT_TIMEOUT_MS);
      expect(await outcomePromise).toEqual({ kind: "interrupted", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("重启 → interrupted:restarted", async () => {
    const { rpc, client } = withFakeClient(() => new Promise(() => {}));
    const outcomePromise = rpc.compact();
    const restartListeners = (rpc as unknown as { restartListeners: Set<(rpc: PiRpc) => void> }).restartListeners;
    for (const listener of restartListeners) listener(rpc);
    expect(await outcomePromise).toEqual({ kind: "interrupted", reason: "restarted" });
    expect(client.unsub).toHaveBeenCalled();
  });

  it("兜底超时 → interrupted:timeout(fake timers 推进,不真实等待)", async () => {
    vi.useFakeTimers();
    try {
      const { rpc } = withFakeClient(() => new Promise(() => {}));
      const outcomePromise = rpc.compact();
      await vi.advanceTimersByTimeAsync(COMPACT_WAIT_TIMEOUT_MS);
      expect(await outcomePromise).toEqual({ kind: "interrupted", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("在途计数:双腿入账——应答 reject(30s Timeout)后等待腿仍在账,事件收尾才出账", async () => {
    const { rpc, client } = withFakeClient(
      () => new Promise((_, reject) => reject(new Error("Timeout waiting for response to compact. Stderr: ")))
    );
    const inner = rpc.requireClient();
    void inner; // 触发 wrapClient 缓存
    const outcomePromise = rpc.compact();
    expect((rpc as unknown as { inFlight: number }).inFlight).toBe(2); // 应答腿 + 等待腿
    await new Promise((r) => setTimeout(r, 0)); // 让应答腿的 reject 分支跑完
    expect((rpc as unknown as { inFlight: number }).inFlight).toBe(1); // 应答腿已出,等待腿在账
    client.fire(compactionEnd());
    await outcomePromise;
    expect((rpc as unknown as { inFlight: number }).inFlight).toBe(0);
  });
});
