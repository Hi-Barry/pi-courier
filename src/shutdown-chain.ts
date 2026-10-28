/**
 * 共享优雅退出链(spec #247 票01):停 pi RPC → 断 transport 连接 → 放单
 * 实例锁 → 退出。自组合根闭包收编成可注入模块,信号路径(SIGTERM/SIGINT/
 * SIGBREAK)与后续票的崩溃守卫(票03)、磁盘硬阈值退出(票04)共用同一条链。
 *
 * 退出码参数化是本模块存在的理由:信号路径照旧传 0,行为与历史逐字节一致;
 * 崩溃/水位路径携带非零码走同一释放序列 —— POSIX systemd 的
 * Restart=on-failure 只对非零退出码拉起,不参数化则「让既有自愈接住」落空。
 *
 * shuttingDown 重入标志归本模块持有:任何路径二次进入直接忽略,防重复释放
 * (票03 的崩溃守卫与信号路径共用此标志,与旧组合根闭包语义一致)。
 */

export interface ShutdownChainDeps {
  /** 优雅退出第一步:停 pi RPC 子进程(失败被吞,后续步骤照走)。 */
  stopRpc: () => Promise<unknown>;
  /** 第二步:断开全部 transport 连接。 */
  disconnectAll: () => Promise<unknown>;
  /** 第三步:释放单实例锁。 */
  releaseLock: () => void;
  /** 退出出口:注入缝 —— 测试用 fake 断言退出码,生产组合根传 process.exit。 */
  exit: (code: number) => void;
  /** 退出横幅日志(注入,模块不依赖全局 logger 的配置时序)。 */
  log: (message: string) => void;
}

export interface ShutdownChain {
  /**
   * 走完整释放序列后退出。exitCode 缺省 0(信号路径语义);释放顺序与
   * 退出码之外无任何新增行为。
   */
  shutdown(reason: string, exitCode?: number): Promise<void>;
  /** 只读查询:是否已进入退出流程(供组合根/守卫侧断言,不暴露写口)。 */
  isShuttingDown(): boolean;
}

export function createShutdownChain(deps: ShutdownChainDeps): ShutdownChain {
  let shuttingDown = false;
  return {
    async shutdown(reason: string, exitCode = 0): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      deps.log(`🛑 ${reason} received — shutting down`);
      await deps.stopRpc().catch(() => {});
      await deps.disconnectAll();
      deps.releaseLock();
      deps.exit(exitCode);
    },
    isShuttingDown(): boolean {
      return shuttingDown;
    },
  };
}
