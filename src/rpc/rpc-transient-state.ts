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

import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { type QueueSnapshot, queueTotal } from "./command-map.js";
import type { PiRpc } from "./pi-rpc.js";

/** How this module learns about restarts: the router wires it to
 *  PiRpc.onRestarted. Injectable so tests can drive invalidation. */
export type RestartSubscription = (rpc: PiRpc, handler: (rpc: PiRpc) => void) => void;

/** 非自愿队列丢失回执(issue #115 阶段1):invalidate 时镜像非空即触发,
 *  让 router 向绑定房间发「N 条未执行」清单。回调抛错不影响作废本身。 */
export type QueueLostHook = (rpc: PiRpc, snapshot: QueueSnapshot) => void;

/** 镜像变更落盘钩子(issue #115 阶段2):setMirror 与 invalidate 都触发,
 *  invalidate 以权威空快照触发 —— 磁盘永远反映「活进程还欠着什么」,
 *  服务级重启后由启动装载补发回执。/stop 钉零与崩溃作废都走这里,
 *  「自己清的/已作废的」不会在下次服务启动被误报。 */
export type MirrorChangedHook = (rpc: PiRpc, snapshot: QueueSnapshot) => void;

export class RpcTransientState {
  private mirrors = new WeakMap<PiRpc, QueueSnapshot>();
  private watched = new WeakSet<PiRpc>();

  constructor(
    private subscribeRestart: RestartSubscription,
    private onQueueLost?: QueueLostHook,
    private onMirrorChanged?: MirrorChangedHook
  ) {}

  private watch(rpc: PiRpc): void {
    if (this.watched.has(rpc)) return;
    this.watched.add(rpc);
    this.subscribeRestart(rpc, (r) => this.invalidate(r));
  }

  /** 进程重启:新子进程对旧队列一无所知 — 镜像作废。作废前镜像非空 =
   *  非自愿丢失(崩溃/重启吞掉排队消息),先触发回执(issue #115 阶段1);
   *  /stop //interrupt 自己清的队列在 clear_queue 成功后镜像已归零,天然
   *  不触发 ——「自己清的」与「崩溃丢的」就此区分。 */
  private invalidate(rpc: PiRpc): void {
    const snapshot = this.mirrors.get(rpc);
    if (snapshot && queueTotal(snapshot) > 0) {
      try {
        this.onQueueLost?.(rpc, snapshot);
      } catch (err) {
        // 回执失败(发送异常等)不影响作废本身 —— 但用户可见通知丢了,得留痕
        logger.warn(`[transient] 作废回执发送失败: ${errorMessage(err)}`);
      }
    }
    this.mirrors.delete(rpc);
    this.notifyMirrorChanged(rpc, { steering: [], followUp: [] });
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
    this.notifyMirrorChanged(rpc, snapshot);
  }

  /** 落盘钩子的唯一出口:setMirror 与 invalidate(权威空)都经此触发;
   *  抛错只吞掉那一次落盘,镜像与作废语义照常。 */
  private notifyMirrorChanged(rpc: PiRpc, snapshot: QueueSnapshot): void {
    try {
      this.onMirrorChanged?.(rpc, snapshot);
    } catch (err) {
      // 落盘失败不影响镜像本身(内存仍是权威)—— 持久化降级留痕
      logger.warn(`[transient] 瞬态状态落盘失败(内存仍权威): ${errorMessage(err)}`);
    }
  }
}
