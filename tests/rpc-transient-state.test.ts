/**
 * RpcTransientState mirror-changed hook (issue #115 stage 2): the disk sink
 * fires on every mirror change — setMirror with the new snapshot, restart
 * invalidation with the authoritative empty — and never on plain reads. The
 * queue-lost hook (stage 1) keeps firing before the empty reaches the disk
 * hook, so a subprocess restart both notifies and un-persists in one pass.
 */
import { describe, expect, it, vi } from "vitest";
import type { PiRpc } from "../src/rpc/pi-rpc";
import { RpcTransientState } from "../src/rpc/rpc-transient-state";

const snapshot = (steering: string[], followUp: string[] = []) => ({ steering, followUp });

function makeRpc(): { rpc: PiRpc; fireRestart: () => void } {
  let hook: ((rpc: PiRpc) => void) | undefined;
  const rpc = {
    label: undefined,
    onRestarted: vi.fn((h: (rpc: PiRpc) => void) => {
      hook = h;
      return () => {};
    }),
  } as unknown as PiRpc;
  return { rpc, fireRestart: () => hook?.(rpc) };
}

describe("RpcTransientState mirror-changed hook (issue #115 stage 2)", () => {
  it("setMirror fires the hook with the snapshot that was set", () => {
    const { rpc, fireRestart } = makeRpc();
    const changed: Array<{ rpc: PiRpc; snapshot: unknown }> = [];
    const state = new RpcTransientState((r, h) => r.onRestarted?.(h), undefined, (r, s) => changed.push({ rpc: r, snapshot: s }));
    state.setMirror(rpc, snapshot(["排队一"], ["排队二"]));
    expect(changed).toEqual([{ rpc, snapshot: snapshot(["排队一"], ["排队二"]) }]);
    fireRestart(); // silence "declared but never used" style concerns — hook is exercised below
  });

  it("invalidation fires the hook with the authoritative empty, after queue-lost", () => {
    const { rpc, fireRestart } = makeRpc();
    const order: string[] = [];
    const lost = vi.fn((_r: PiRpc, s: { steering: string[] }) => {
      order.push(`lost:${s.steering.length}`);
    });
    const changed = vi.fn((_r: PiRpc, s: { steering: string[] }) => {
      order.push(`changed:${s.steering.length}`);
    });
    const state = new RpcTransientState((r, h) => r.onRestarted?.(h), lost, changed);
    state.setMirror(rpc, snapshot(["排队一", "排队二"]));
    changed.mockClear();
    order.length = 0; // setMirror 的那次落盘不计入 —— 本用例只看作废时序
    fireRestart();
    expect(lost).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    // 阶段1回执先走(丢失清单),落盘钩子后走(权威空)—— 磁盘不再欠账。
    expect(order).toEqual(["lost:2", "changed:0"]);
  });

  it("an empty mirror restart (nothing to lose) still unpersists", () => {
    const { rpc, fireRestart } = makeRpc();
    const lost = vi.fn();
    const changed = vi.fn();
    const state = new RpcTransientState((r, h) => r.onRestarted?.(h), lost, changed);
    state.setMirror(rpc, snapshot([], []));
    changed.mockClear();
    fireRestart();
    expect(lost).not.toHaveBeenCalled(); // stage 1: nothing lost, silence
    expect(changed).toHaveBeenCalledWith(rpc, snapshot([], [])); // stage 2: disk stays clean
  });

  it("plain mirror() reads never fire the hook", () => {
    const { rpc } = makeRpc();
    const changed = vi.fn();
    const state = new RpcTransientState((r, h) => r.onRestarted?.(h), undefined, changed);
    state.setMirror(rpc, snapshot(["一次"]));
    changed.mockClear();
    expect(state.mirror(rpc)?.steering).toEqual(["一次"]);
    expect(state.mirror(rpc)?.steering).toEqual(["一次"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("a throwing sink never breaks the mirror or the restart lifecycle", () => {
    const { rpc, fireRestart } = makeRpc();
    const state = new RpcTransientState(
      (r, h) => r.onRestarted?.(h),
      undefined,
      () => {
        throw new Error("disk on fire");
      }
    );
    expect(() => state.setMirror(rpc, snapshot(["排队一"]))).not.toThrow();
    expect(() => fireRestart()).not.toThrow();
    expect(state.mirror(rpc)).toBeUndefined(); // invalidation still happened
  });
});
