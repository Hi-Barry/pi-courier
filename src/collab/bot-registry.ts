/**
 * BotRegistry — 房间内对端 bot 身份的读取缓存(spec #299 票02)。
 *
 * 登记簿本体是房间的自定义状态事件(每 bot 一条,state_key = 其 MXID,
 * 内容带写入方署名 —— 写侧幂等,见 RoomOps.registerRoomBot)。读侧经
 * RoomOps.getRoomBots 全量取一次后按房间做 TTL 缓存:路由器每条消息都
 * 要问"发信人是不是 bot",不能逐条打一次全量状态 API。
 *
 * 容量语义:MatrixRoomOps 未接(测试假件/非 Matrix 部署)或方法缺失时
 * 返回空集 —— 没有登记簿就没有过滤,行为与 1.6.x 逐字节一致。
 */

import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import type { RoomOps } from "../transports/interface.js";

const CACHE_TTL_MS = 60_000;

export class BotRegistry {
  private cache = new Map<string, { bots: Set<string>; at: number }>();

  constructor(private readonly roomOps?: RoomOps) {}

  /** 本房间已登记的 bot MXID 集合(TTL 缓存;读失败按空集降级并留痕)。 */
  async botsOf(roomId: string): Promise<Set<string>> {
    const hit = this.cache.get(roomId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bots;
    const ops = this.roomOps;
    if (!ops || typeof ops.getRoomBots !== "function") {
      // 旧假件/非 Matrix 部署:无登记簿能力 = 不过滤(与旧版一致)。
      return new Set();
    }
    try {
      const bots = new Set(await ops.getRoomBots(roomId));
      this.cache.set(roomId, { bots, at: Date.now() });
      return bots;
    } catch (err) {
      // 读失败沿用上一份(即使过期)缓存(任务2 审计整改):空集 = 放弃过滤,
      // 会短暂重开 bot 互聊回环;有旧名单时宁可保守。全无旧名单才真正放行。
      const stale = this.cache.get(roomId);
      if (stale) return stale.bots;
      logger.warn(`[bot-registry] 读取房间 ${roomId} 的 bot 登记簿失败,按空集处理: ${errorMessage(err)}`);
      return new Set();
    }
  }

  /** 已缓存(未过期)的登记簿快照:同步读,供活卡/typing 的模式解析用
   *  (spec #299 票06 —— "含客座的协作房默认关工具流"需同步判定;缓存由
   *  botFilter 对每条消息的读自然保温)。未缓存/过期 → undefined。 */
  cached(roomId: string): Set<string> | undefined {
    const hit = this.cache.get(roomId);
    return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.bots : undefined;
  }
}
