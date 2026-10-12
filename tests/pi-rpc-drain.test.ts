/**
 * PiRpc 在途计数与重启排水(F5 治本)。
 *
 * 登录成功触发的自动重启会 SIGTERM pi 子进程,彼时仍在途的桥→pi 请求随
 * 进程死亡被拒收成用户可见的 ❌(Agent process exited code=143)。修复:
 * requireClient() 返回计数包装客户端,restart 前先 drainInFlight 排空
 * (超时兜底照杀 —— 进程终究要重启)。白盒:client/inFlight 为私有,
 * 仿照 pi-rpc-send.test.ts 的注入模式。
 */
import { describe, expect, it } from "vitest";
import { PiRpc, RESTART_DRAIN_TIMEOUT_MS } from "../src/rpc/pi-rpc";

function withFakeClient(client: Record<string, unknown>): PiRpc {
  const rpc = new PiRpc();
  (rpc as unknown as { client: unknown }).client = client;
  return rpc;
}

const inFlight = (rpc: PiRpc) => (rpc as unknown as { inFlight: number }).inFlight;

describe("PiRpc 在途计数(requireClient 包装)", () => {
  it("Promise 型调用入账,settled 后出账", async () => {
    let release!: (v?: unknown) => void;
    const rpc = withFakeClient({ getState: () => new Promise((r) => (release = r)) });
    const pending = rpc.requireClient().getState();
    expect(inFlight(rpc)).toBe(1);
    release({ isStreaming: false });
    await pending;
    expect(inFlight(rpc)).toBe(0);
  });

  it("拒绝的调用也出账(计数不漏)", async () => {
    const rpc = withFakeClient({ getState: () => Promise.reject(new Error("boom")) });
    await expect(rpc.requireClient().getState()).rejects.toThrow("boom");
    expect(inFlight(rpc)).toBe(0);
  });

  it("包装客户端按底层实例缓存,同一进程是同一包装", () => {
    const rpc = withFakeClient({ getState: () => Promise.resolve({}) });
    expect(rpc.requireClient()).toBe(rpc.requireClient());
  });

  it("同步方法透传且不计数(onEvent 返回退订函数)", () => {
    const unsub = () => {};
    const rpc = withFakeClient({ onEvent: () => unsub });
    expect(rpc.requireClient().onEvent(() => {})).toBe(unsub);
    expect(inFlight(rpc)).toBe(0);
  });
});

describe("drainInFlight(重启前排空)", () => {
  it("无在途时立即返回", async () => {
    const t0 = Date.now();
    await new PiRpc().drainInFlight(1000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("等在途收尾后排空", async () => {
    const rpc = new PiRpc();
    (rpc as unknown as { inFlight: number }).inFlight = 1;
    setTimeout(() => {
      (rpc as unknown as { inFlight: number }).inFlight = 0;
    }, 120);
    const t0 = Date.now();
    await rpc.drainInFlight(2000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });

  it("僵死请求按超时兜底返回,不无限拖延", async () => {
    const rpc = new PiRpc();
    (rpc as unknown as { inFlight: number }).inFlight = 1;
    const t0 = Date.now();
    await rpc.drainInFlight(150);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });

  it("兜底上限是有量纲的正数(≥1s,正常请求远快于此)", () => {
    expect(RESTART_DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });
});
