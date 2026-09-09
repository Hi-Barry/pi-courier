/**
 * Per-pi-process transient state (spec #72 票6/C5) — queue mirrors and
 * pending extension_ui questions. The state owns its invalidation: it
 * subscribes to each rpc's restart lifecycle once, at first touch, and clears
 * itself when the subprocess comes back fresh. Nobody outside this module
 * needs to remember to clear anything (the old clearRpcState trigger wire is
 * gone from the slash-command context and the login manager).
 *
 * A restarted subprocess knows nothing of the questions (or queue) the old
 * one left behind — without invalidation they would swallow the room's next
 * message as a bogus "answer" to a question the new process will never
 * resolve.
 */

import type { ReplyTarget } from "../types.js";
import type { QueueSnapshot } from "./command-map.js";
import type { ExtensionUIRequestView } from "./message-router.js";
import type { PiRpc } from "./pi-rpc.js";

/** A question asked in a room and still awaiting the answer. FIFO per rpc —
 *  the oldest pending question is answered first. The target is captured at
 *  ask time so the answer/timeout routes back even if the default rpc's
 *  binding moves on to another prompter in between. */
export interface PendingExtensionQuestion {
  request: ExtensionUIRequestView;
  target: ReplyTarget;
  timer: NodeJS.Timeout;
}

/** How this module learns about restarts: the router wires it to
 *  PiRpc.onRestarted. Injectable so tests can drive invalidation. */
export type RestartSubscription = (rpc: PiRpc, handler: (rpc: PiRpc) => void) => void;

export class RpcTransientState {
  private mirrors = new WeakMap<PiRpc, QueueSnapshot>();
  private questions = new WeakMap<PiRpc, PendingExtensionQuestion[]>();
  private watched = new WeakSet<PiRpc>();

  constructor(private subscribeRestart: RestartSubscription) {}

  private watch(rpc: PiRpc): void {
    if (this.watched.has(rpc)) return;
    this.watched.add(rpc);
    this.subscribeRestart(rpc, (r) => this.invalidate(r));
  }

  /** 进程重启:新子进程对旧问题/旧队列一无所知 — 镜像与悬置提问全部作废。 */
  private invalidate(rpc: PiRpc): void {
    this.mirrors.delete(rpc);
    const queue = this.questions.get(rpc);
    if (queue) {
      for (const question of queue) clearTimeout(question.timer);
      this.questions.delete(rpc);
    }
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

  /** The FIFO question queue for an rpc (created on demand). */
  questionQueue(rpc: PiRpc): PendingExtensionQuestion[] {
    this.watch(rpc);
    const queue = this.questions.get(rpc) ?? [];
    this.questions.set(rpc, queue);
    return queue;
  }
}
