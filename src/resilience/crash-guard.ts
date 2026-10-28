/**
 * L1 崩溃守卫(spec #247 票03):未捕获异常 / 未处理 Promise 拒绝的全局兜底,
 * 把「无声死」变成「留言死」。
 *
 * 处理顺序(固定):① 结构化记录死因(错误名 + 消息 + 栈,进日志)→
 * ② 尽力向管理房发一条死因留言(整条限时兜底,超时放弃;transport 未连接
 * 或未配管理房则组合根注入的 notify 为 undefined/自行静默,只记日志,失败
 * 不追)→ ③ 沿共享退出链以非零码有序退出(票01 参数化后的同一条链,与
 * 信号路径共用 shuttingDown 重入标志)。
 *
 * 注入缝三样(与启动状态模块、审计日志 onDegraded 同款模式):日志、管理房
 * 通知回调、退出回调。process 事件监听由组合根注册 —— 本模块的测试不碰
 * 真实 process 事件。处理器内部任何一环再抛错时直接硬退,兜底自身不许成为
 * 二次崩溃源。
 *
 * `unhandledRejection` 与 `uncaughtException` 走同一处理链:Node ≥15 默认
 * 本就 crash,显式接管只是把「无序死」换序成「留言 + 有序死」,行为不倒退。
 */

/** 崩溃退出码(EX_SOFTWARE 惯例,非零即让 POSIX systemd Restart=on-failure
 *  接住;与启动失败 exit(1) 区分,日志/排查有辨识度)。 */
export const CRASH_EXIT_CODE = 70;

/** 通知限时默认(毫秒):整条管理房留言的兜底上限,超时放弃照常退出。 */
export const CRASH_NOTIFY_TIMEOUT_MS = 5000;

export interface CrashGuardDeps {
  /** ① 死因结构化日志(错误名 + 消息 + 栈)。 */
  log: (message: string) => void;
  /**
   * ② 管理房死因留言(组合根路由 sendReply + i18n 文案);undefined =
   * 未配管理房/transport 未连接,静默跳过只记日志。实现自带抛错也无妨 ——
   * 守卫捕获后不追。
   */
  notify?: (reason: string) => Promise<void>;
  /** ③ 共享优雅退出链(票01):shutdown(reason, exitCode)。 */
  shutdown: (reason: string, exitCode?: number) => Promise<void>;
  /** 硬退兜底缝:生产 process.exit,测试 fake 断言「守卫必然导致退出」。 */
  hardExit: (code: number) => void;
  /** 通知限时毫秒(测试可缩短;默认 CRASH_NOTIFY_TIMEOUT_MS)。 */
  notifyTimeoutMs?: number;
}

export interface CrashGuard {
  /**
   * 统一处理入口:uncaughtException 与 unhandledRejection 同路。kind 仅进
   * 日志辨识来源("uncaughtException"/"unhandledRejection")。单飞:并发
   * 异常只处理首个,其余忽略(退出已在进行,重复留言无意义)。
   */
  handleCrash(kind: string, error: unknown): Promise<void>;
}

/** 死因单行摘要(错误名 + 消息;非 Error 值 String 化)—— 给管理房留言。 */
export function crashReason(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createCrashGuard(deps: CrashGuardDeps): CrashGuard {
  let entered = false;

  const handleCrash = async (kind: string, error: unknown): Promise<void> => {
    if (entered) return;
    entered = true;

    const reason = crashReason(error);
    // ① 结构化死因进日志:错误名 + 消息 + 栈。log 自身抛错也直接硬退。
    try {
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      deps.log(`[crash] ${kind}: ${reason}${stack ? `\n${stack}` : ""}`);
    } catch {
      deps.hardExit(CRASH_EXIT_CODE);
      return;
    }

    // ② 尽力发管理房死因留言:限时兜底(默认 5 秒)、失败/超时不追。
    if (deps.notify) {
      const timeoutMs = deps.notifyTimeoutMs ?? CRASH_NOTIFY_TIMEOUT_MS;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        Promise.resolve()
          .then(() => deps.notify!(reason))
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            () => {
              clearTimeout(timer);
              resolve();
            }
          );
      });
    }

    // ③ 沿共享退出链以非零码有序退出;退出链自身抛错则硬退 —— 兜底不许
    // 成为二次崩溃源。正常路径 shutdown 内部 process.exit 永不返回;若返回
    // (注入 fake / 被重入标志挡住),同样硬退兜底「守卫必然导致退出」。
    try {
      await deps.shutdown(kind, CRASH_EXIT_CODE);
    } catch {
      deps.hardExit(CRASH_EXIT_CODE);
      return;
    }
    deps.hardExit(CRASH_EXIT_CODE);
  };

  return { handleCrash };
}
