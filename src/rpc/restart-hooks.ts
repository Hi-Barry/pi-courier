/**
 * RpcRestartHooks — per-rpc 重启失效钩子的键控注册表(#354,评审卡4)。
 *
 * 「重启懒订阅 + WeakSet 去重」样板此前自我复制 6 处(router 的三张
 * WeakSet:活卡/工作流卡/降级链,外加 RpcTransientState/RecapLedger/
 * ExtensionQuestions 各自手搓;spec #335 的 fallbackRestartWatched 靠注释
 * 引用上一个实例自我复制)。本注册表收口 router 侧的三张:进程首见任一
 * 键时挂一次 onRestarted 订阅,触发时广播该 rpc 已登记的全部钩子 ——
 * 各特性只登记「重启时清什么」,不再自带 WeakSet。
 *
 * 同键幂等:卡片机在每次开卡时调用 once,同键重复登记为空操作(钩子只入
 * 列一次);不同键各自入列(同一进程可同时挂活卡/工作流/降级链三类清理)。
 * 后登记的键在先订阅已就绪的情况下直接追加 —— 订阅只发生一次。
 *
 * RpcTransientState/RecapLedger/ExtensionQuestions 的自持订阅不动:它们是
 * 自包含深模块(状态与失效时机自治),收编反而破坏其零依赖形状。
 */

import type { PiRpc } from "./pi-rpc.js";

export class RpcRestartHooks {
  /** 已登记的键(按 rpc):once 幂等的依据。 */
  private registered = new WeakMap<PiRpc, Set<string>>();
  /** 钩子表(按 rpc):触发时按登记序广播。 */
  private hooks = new WeakMap<PiRpc, Array<() => void>>();

  constructor(private readonly subscribe: (rpc: PiRpc, handler: () => void) => void) {}

  /** 按键登记一次「重启时清什么」;该 rpc 首见任一键时挂一次订阅。 */
  once(rpc: PiRpc, key: string, hook: () => void): void {
    const keys = this.registered.get(rpc) ?? new Set<string>();
    if (keys.has(key)) return;
    keys.add(key);
    this.registered.set(rpc, keys);
    const existing = this.hooks.get(rpc);
    if (existing) {
      existing.push(hook);
      return;
    }
    const list = [hook];
    // 钩子先入列再订阅:订阅即触发的实现也不会漏掉第一个钩子。
    this.hooks.set(rpc, list);
    this.subscribe(rpc, () => {
      for (const h of this.hooks.get(rpc) ?? []) h();
    });
  }
}
