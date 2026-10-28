/**
 * McpLoginFlow — /mcp login 的编排器(spec #246;与热更新分支
 * feat/hot-update-command 的 UpdateOrchestrator 同构的单飞状态机 + 代次栅栏
 * —— 该先例未并入本分支基线,本文件不依赖它,仅设计出处):
 *  - 单飞状态机 idle → urlSent → waiting →(结算归)idle。done/failed/expired
 *    是结算分类(McpLoginOutcome),不是持久状态:结算即归位 idle,流程可
 *    重试、桥不留悬挂 —— 与热更新编排器「终态不存在、完成即 idle」同款。
 *  - 代次栅栏(先例见 feat/hot-update-command 分支的 src/update/updater.ts
 *    代次仲裁;基线上无此文件):占位/结算/作废三处
 *    都推进代次;流闭包在发起时捕获 myGen,行回调、URL 转发、收尾结算的
 *    一切写回前先校验 stale(),迟到的 close/SIGKILL 竞态与 invalidate 之后
 *    的旧流事件一律只结「invalidated」标记、不写回状态、不发聊天回执。
 *  - 占位是同步 CAS(零 await):占位必须先于一切 await,晚一步就有双编排
 *    窗口(斜杠命令管道对并发消息无串行化,热更新编排器同款纪律)。
 *  - 授权 URL 行一经解析即经 hooks.onAuthUrl 回调上抛(命令层转发聊天,
 *    附回跳限制与 SSH 隧道提示),转发落定后才转 waiting;转发失败只留痕
 *    不杀编排 —— pi 仍在等回跳,杀流只会把可完成的登录变成黑箱失败。
 *    同一批 stdout 里的重复 URL 组以同步 delivered 标志去重(状态位要等
 *    await 落定才更新,挡不住同批第二次触发)。
 *  - 超时硬上限 600s 由本层钳制 timeoutSec 后交执行缝;执行缝(mcp-cli
 *    startLogin)内部有同款钳制与 SIGKILL 兜底,timedOut=true 的收尾在
 *    本层结算为 expired。
 *
 * 执行缝(runLogin)与行解析器工厂(makeLineParser)全部可注入:行为测试
 * 一律喂假件,真实 pi 与外部 MCP 服务器不进测试(spec Testing Decisions)。
 */
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import {
  MCP_LOGIN_DEFAULT_TIMEOUT_S,
  MCP_LOGIN_TIMEOUT_MAX_S,
  type McpLoginResult,
  startLogin,
} from "./mcp-cli.js";
import {
  createLoginLineParser,
  type McpLoginLineParser,
} from "./mcp-formatters.js";

/** 持久状态(终态不占位:结算即归 idle,分类进 McpLoginOutcome)。 */
export type McpLoginState = "idle" | "urlSent" | "waiting";

/**
 * 登录结算分类:
 *  - done:pi 退出 0 且见到成功行;already=true 为「本已登录」
 *    (Already signed in 行),false 为新登录成功(Signed in 行)。
 *  - failed:非零退出 / code 0 但无成功标记(文案漂移兜底)/ spawn 失败;
 *    message 带输出尾部,code 保留退出码(spawn 失败为 undefined)。
 *  - expired:桥侧硬上限到点、执行缝 SIGKILL 兜底(timedOut=true);
 *    timeoutSec 为实际生效的钳后时长(回执文案用)。
 *  - unavailable:pi 入口解析失败(pi 缺失,执行缝 unavailable 字段)——
 *    版本门回执,与短命令同口径,不结成普通 failed。
 *  - invalidated:代次作废(invalidate 后旧流的迟到收尾)——不产生聊天
 *    回执,仅让挂起的 done promise 有尽头。
 */
export type McpLoginOutcome =
  | { kind: "done"; server: string; already: boolean }
  | { kind: "failed"; server: string; message: string; code: number | undefined }
  | { kind: "expired"; server: string; timeoutSec: number }
  | { kind: "unavailable"; server: string; message: string }
  | { kind: "invalidated"; server: string };

/** start 的即时结果:started 带终局 promise(命令层可 void 挂后台);busy 为并发拒绝。 */
export type McpLoginStart =
  | { kind: "started"; done: Promise<McpLoginOutcome> }
  | { kind: "busy"; server: string };

/** 编排回调(命令层接线;全部可选,自吞错不影响状态机)。 */
export interface McpLoginHooks {
  /** 授权 URL 即时上抛(转发聊天,附回跳限制与 SSH 隧道提示);可返回
   *  promise,编排器 await 其落定后才转 waiting。 */
  onAuthUrl?: (url: string, server: string) => Promise<void> | void;
  /** 终局回执(成功/失败/超时;invalidated 不经此回调)。抛错仅留痕,
   *  不回滚状态归位。 */
  onFinished?: (outcome: McpLoginOutcome) => Promise<void> | void;
  /** 未识别行原文透传(诊断缝;命令层可不接)。 */
  onRawLine?: (line: string, server: string) => void;
}

export interface McpLoginFlowDeps extends McpCliDepsShape {
  /** 登录执行缝(默认 mcp-cli 的 startLogin,deps 原样透传;测试注入假件)。 */
  runLogin?: (
    server: string,
    timeoutSec: number,
    onLine: (line: string) => void,
  ) => Promise<McpLoginResult>;
  /** 行解析器工厂(默认 createLoginLineParser;钉住 pi 1.0.0 文案,见
   *  mcp-formatters.ts 模块头)。 */
  makeLineParser?: () => McpLoginLineParser;
  /** 未指定/非法时长时的缺省秒数(默认 MCP_LOGIN_DEFAULT_TIMEOUT_S=300)。 */
  loginDefaultTimeoutS?: number;
}

/** 结构子集(避免反向依赖 mcp-cli 的依赖图,测试假件免带 spawn 全家桶)。 */
interface McpCliDepsShape {
  loginTimeoutMaxS?: number;
  logger?: Pick<typeof logger, "info" | "warn" | "error">;
}

/** 失败详情的尾部上限(自由文本进回执前截断;与执行缝 oneTail 同纪律)。 */
const DETAIL_TAIL_LIMIT = 300;

function tailOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  return collapsed.length > DETAIL_TAIL_LIMIT
    ? `…${collapsed.slice(-DETAIL_TAIL_LIMIT)}`
    : collapsed;
}

export class McpLoginFlow {
  private state: McpLoginState = "idle";
  /**
   * 编排代次:占位、结算、invalidate 三处推进;流闭包捕获发起时的 myGen,
   * 之后一切写回(URL 转发、waiting 转移、终局归位)先校验 stale() ——
   * invalidate/迟到的同流事件从此全部作废,防陈旧写回(热更新编排器同款)。
   */
  private generation = 0;
  private activeServer: string | undefined;
  /** 授权链接是否已上抛(去重标志):状态位 urlSent→waiting 要等转发 await
   *  落定才更新,同一批 stdout 里的第二组「提示行+URL 行」会在落定前再次
   *  触发 deliverUrl —— 同步检查并置位本标志,链接至多转发一次。 */
  private urlDelivered = false;

  constructor(private readonly deps: McpLoginFlowDeps = {}) {}

  private get log(): Pick<typeof logger, "info" | "warn" | "error"> {
    return this.deps.logger ?? logger;
  }

  /** 当前持久状态(测试断言与组合根日志用)。 */
  get currentState(): McpLoginState {
    return this.state;
  }

  /** 在途登录的服务器名(并发拒绝回执文案用;空闲为 undefined)。 */
  get busyServer(): string | undefined {
    return this.activeServer;
  }

  /** timeoutSec 钳制:非法(≤0/NaN/缺省)→ 缺省值;超硬上限 → 硬上限。
   *  本层必须自钳 —— 执行缝可被注入替换,编排器不能依赖缝内的钳制。 */
  private clampTimeout(timeoutSec: number | undefined): number {
    const max = this.deps.loginTimeoutMaxS ?? MCP_LOGIN_TIMEOUT_MAX_S;
    const fallback = this.deps.loginDefaultTimeoutS ?? MCP_LOGIN_DEFAULT_TIMEOUT_S;
    if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      return fallback;
    }
    return Math.min(Math.floor(timeoutSec), max);
  }

  /**
   * 单飞发起登录。同步段(零 await)完成 CAS 占位:idle → urlSent,代次
   * +1;非 idle 一律拒绝(busy,带在途服务器名,命令层回报「已有登录
   * 进行中」)。占位后编排挂后台(started.done 可 void),URL 与终局经
   * hooks 异步上抛。
   */
  start(server: string, timeoutSec: number | undefined, hooks: McpLoginHooks = {}): McpLoginStart {
    if (this.state !== "idle") {
      return { kind: "busy", server: this.activeServer ?? server };
    }
    const clamped = this.clampTimeout(timeoutSec);
    this.activeServer = server;
    // 占位态即 urlSent(「编排已发起、链接即将上抛」):URL 转发落定后才
    // 转 waiting,顺序严格 idle → urlSent → waiting。
    this.state = "urlSent";
    this.urlDelivered = false;
    this.generation += 1;
    const myGen = this.generation;
    const stale = (): boolean => this.generation !== myGen;
    this.log.info(`[mcp] login flow started: server="${server}" timeout=${clamped}s`);

    const parser = (this.deps.makeLineParser ?? createLoginLineParser)();
    let sawSignedIn = false;
    let sawAlready = false;
    const onLine = (line: string): void => {
      // 行事件是执行缝的同步 data 回调;代次已作废 → 整流已死,零副作用
      // (连 URL 都不再上抛)。
      if (stale()) return;
      const parsed = parser(line);
      switch (parsed.kind) {
        case "auth-url":
          // 授权 URL 即时上抛(转发聊天);这不结束编排 —— 落定后转 waiting。
          void this.deliverUrl(hooks, server, parsed.url, myGen);
          return;
        case "already-signed-in":
          sawAlready = true;
          return;
        case "signed-in":
          sawSignedIn = true;
          return;
        case "raw":
          try {
            hooks.onRawLine?.(line, server);
          } catch {
            // 诊断缝自吞:不影响编排。
          }
          return;
      }
    };

    const done = (async (): Promise<McpLoginOutcome> => {
      let result: McpLoginResult;
      try {
        const runLogin =
          this.deps.runLogin ??
          ((srv: string, sec: number, onLn: (line: string) => void) =>
            startLogin(srv, sec, onLn, this.deps));
        result = await runLogin(server, clamped, onLine);
      } catch (err) {
        // 执行缝契约外抛错:按失败结算(占位释放,不留悬挂)。
        if (stale()) return { kind: "invalidated", server };
        return await this.settle(
          hooks,
          { kind: "failed", server, message: t("cmd.mcp.login.seamError", { message: errorMessage(err) }), code: undefined },
          myGen,
        );
      }
      if (stale()) return { kind: "invalidated", server };
      // 结算判定顺序:版本门(pi 缺失)→ 超时 → spawn 失败 → 成功(区分
      // 「本已登录」)→ 黑箱失败。
      if (result.unavailable !== undefined) {
        return await this.settle(
          hooks,
          { kind: "unavailable", server, message: result.unavailable },
          myGen,
        );
      }
      if (result.timedOut) {
        return await this.settle(hooks, { kind: "expired", server, timeoutSec: clamped }, myGen);
      }
      if (result.spawnError !== undefined) {
        return await this.settle(
          hooks,
          { kind: "failed", server, message: t("cmd.mcp.detail.spawnFailed", { message: result.spawnError }), code: undefined },
          myGen,
        );
      }
      if (result.code === 0 && sawSignedIn) {
        return await this.settle(hooks, { kind: "done", server, already: false }, myGen);
      }
      if (result.code === 0 && sawAlready) {
        return await this.settle(hooks, { kind: "done", server, already: true }, myGen);
      }
      const detail =
        tailOf(result.stderr) ||
        tailOf(result.stdout) ||
        (result.code === 0
          ? t("cmd.mcp.login.noSuccessMark")
          : t("cmd.mcp.login.exitCode", { code: result.code ?? t("common.unknown") }));
      return await this.settle(hooks, { kind: "failed", server, message: detail, code: result.code }, myGen);
    })();
    return { kind: "started", done };
  }

  /**
   * 代次作废:在途流的一切迟到写回(URL 转发、waiting 转移、终局归位)
   * 从此 stale,其 done promise 结算为 invalidated;状态即刻归 idle,可
   * 立即再次发起。清悬挂入口(桥重启回调 / 未来取消命令接线用);idle 时
   * 为无害 no-op。
   */
  invalidate(reason = "unspecified"): void {
    if (this.state === "idle") return;
    const server = this.activeServer;
    this.state = "idle";
    this.generation += 1;
    this.activeServer = undefined;
    this.log.info(`[mcp] login flow invalidated: server="${server}" reason=${reason}`);
  }

  /** URL 转发与 waiting 转移:转发落定前状态不动(仍是 urlSent);作废、
   *  已 waiting 或链接已上抛过(同批重复 URL 组)则直接放弃。 */
  private async deliverUrl(
    hooks: McpLoginHooks,
    server: string,
    url: string,
    myGen: number,
  ): Promise<void> {
    if (this.generation !== myGen || this.state !== "urlSent" || this.urlDelivered) return;
    // 同步置位(先于一切 await):状态位要等转发落定才转 waiting,挡不住
    // 同一批 stdout 里第二组「提示行+URL 行」的再次触发。
    this.urlDelivered = true;
    try {
      await hooks.onAuthUrl?.(url, server);
    } catch (err) {
      // 转发失败不杀编排:pi 仍在等回跳,杀流只会把可完成的登录变成黑箱失败。
      this.log.warn(`[mcp] auth url notice failed for "${server}": ${errorMessage(err)}`);
    }
    if (this.generation !== myGen || this.state !== "urlSent") return;
    // 链接已交到用户手里 → waiting(等浏览器回跳完成)。
    this.state = "waiting";
  }

  /** 结算唯一入口:终局归位(状态回 idle + 代次推进)后发回执;回执抛错
   *  仅留痕、不回滚归位。代次已变(双保险)只结 invalidated、不写回。 */
  private async settle(
    hooks: McpLoginHooks,
    outcome: McpLoginOutcome,
    myGen: number,
  ): Promise<McpLoginOutcome> {
    if (this.generation !== myGen) {
      return { kind: "invalidated", server: outcome.server };
    }
    this.state = "idle";
    this.generation += 1;
    this.activeServer = undefined;
    try {
      await hooks.onFinished?.(outcome);
    } catch (err) {
      this.log.warn(`[mcp] login finish notice failed for "${outcome.server}": ${errorMessage(err)}`);
    }
    return outcome;
  }
}
