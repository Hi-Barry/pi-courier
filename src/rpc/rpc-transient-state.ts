/**
 * Per-pi-process transient state (spec #72 票6/C5) — the live steering/
 * followUp queue mirror. The state owns its invalidation: it subscribes to
 * each rpc's restart lifecycle once, at first touch, and clears itself when
 * the subprocess comes back fresh. Nobody outside this module needs to
 * remember to clear anything (the old clearRpcState trigger wire is gone
 * from the slash-command context and the login manager).
 *
 * A restarted subprocess knows nothing of the queue the old one left
 * behind — without invalidation a stale mirror would feed /queue and the
 * stop/interrupt queue warning phantom entries.
 *
 * 悬置 extension_ui 提问(spec #99 票3 / issue #104)不在这里:提问机
 * (extension-questions.ts)自持 FIFO 队列与超时计时器,经同一个重启生命周期
 * 订阅接缝自行失效 —— 两个状态都只依赖 rpc.onRestarted,互不纠缠。
 */

import type { QueueSnapshot } from "./command-map.js";
import type { PiRpc } from "./pi-rpc.js";

/** How this module learns about restarts: the router wires it to
 *  PiRpc.onRestarted. Injectable so tests can drive invalidation. */
export type RestartSubscription = (rpc: PiRpc, handler: (rpc: PiRpc) => void) => void;

export class RpcTransientState {
  private mirrors = new WeakMap<PiRpc, QueueSnapshot>();
  private watched = new WeakSet<PiRpc>();

  constructor(private subscribeRestart: RestartSubscription) {}

  private watch(rpc: PiRpc): void {
    if (this.watched.has(rpc)) return;
    this.watched.add(rpc);
    this.subscribeRestart(rpc, (r) => this.invalidate(r));
  }

  /** 进程重启:新子进程对旧队列一无所知 — 镜像作废。 */
  private invalidate(rpc: PiRpc): void {
    this.mirrors.delete(rpc);
  }

  /** Live steering/followUp queue mirror (refreshed by queue_update events).
   *  Read path for /queue and the stop/interrupt queue warning. */
  mirror(rpc: PiRpc): QueueSnapshot | undefined {
    this.watch(rpc);
    return this.mirrors.get(rpc);
  }

  setMirror(rpc: PiRpc, snapshot: QueueSnapshot): void {
    this.watch(rpc);
    this.mirrors.set(rpc, snapshot);
  }
}
