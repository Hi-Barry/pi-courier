/**
 * ClaimLedger — 客座认领簿记的域入口(spec #299 票02/票04 → #352 收口)。
 *
 * 三个落盘簿记的唯一属主(全部住在 config.collab,形状不变向后兼容):
 *  - pendingClaims:待认领邀请(管理房确认卡背后的持久簿记,重启不丢);
 *  - claimRejectedKeys:已拒绝的「房间|仓库地址」键(同房同 URL 不再发卡,
 *    URL 后补/变更则允许重新发卡);
 *  - unknownNotifiedRooms:已发过认领提示的陌生房(同房不重复刷)。
 *
 * 写侧纪律内化(此前靠注释维持,散在 router 与 pmctl 两处):
 *  - 落盘前重读:sendReply/clone 等 await 点后并发安全,写回以当下 store
 *    值为基(spec #299 票04 评审整改口径);
 *  - 上限收敛:pendingClaims 50(任务2 审计整改,恶意批量拉房不再无限
 *    膨胀配置文件;#352 起 router 写路径同受此限 —— 审计意图的漏网补齐)、
 *    键/房簿记 200(评审整改:簿记有界);
 *  - 拒绝按对象身份过滤(票04 评审整改):不整写入口快照,读写窗内并发
 *    新增的邀请保留(store.update 携带条目引用,身份跨重读稳定)。
 */

import type { ConfigStore } from "../config.js";
import type { PendingClaim } from "../types.js";

/** 待认领挂单上限(任务2 审计整改口径,#352 起全写路径统一)。 */
const CLAIMS_CAP = 50;
/** 已拒绝键 / 已提示房的上限(评审整改:簿记有界)。 */
const KEYS_CAP = 200;

export class ClaimLedger {
  constructor(private readonly store: ConfigStore) {}

  /** 待认领清单快照(只读;/pmctl claim 清单与 index 解析用)。 */
  claims(): PendingClaim[] {
    return this.store.get().collab?.pendingClaims ?? [];
  }

  /** 该房是否已有挂单(认领卡去重:挂单存在不重发)。 */
  hasPendingClaim(roomId: string): boolean {
    return this.claims().some((c) => c.roomId === roomId);
  }

  /** 「房间|仓库地址」是否已被拒绝(同房同 URL 不再发卡)。 */
  isRejectedFor(roomId: string, url: string): boolean {
    return (this.store.get().collab?.claimRejectedKeys ?? []).includes(`${roomId}|${url}`);
  }

  /** 普通提示是否已发过(无元数据的陌生房,每房一次)。 */
  hasNoticed(roomId: string): boolean {
    return (this.store.get().collab?.unknownNotifiedRooms ?? []).includes(roomId);
  }

  /** 发出认领卡后落簿:挂单 + 已提示房同一次写(卡已发出,两簿记同步)。 */
  recordClaimCard(roomId: string, url: string, projectName: string): void {
    const fresh = this.store.get().collab;
    this.store.update({
      collab: {
        ...fresh,
        unknownNotifiedRooms: [...(fresh?.unknownNotifiedRooms ?? []), roomId].slice(-KEYS_CAP),
        pendingClaims: [
          ...(fresh?.pendingClaims ?? []),
          { roomId, url, projectName, at: Date.now() },
        ].slice(-CLAIMS_CAP),
      },
    });
  }

  /** 普通提示落簿:只记已提示房。 */
  recordNotice(roomId: string): void {
    const fresh = this.store.get().collab;
    this.store.update({
      collab: {
        ...fresh,
        unknownNotifiedRooms: [...(fresh?.unknownNotifiedRooms ?? []), roomId].slice(-KEYS_CAP),
      },
    });
  }

  /** 拒绝第 index1 条(1 起计,与 /pmctl claim reject 的 index 口径同源):
   *  按对象身份移除 + 拒绝键带 URL,同一次写。越界返回 undefined(调用方
   *  回执 indexOOB)。 */
  rejectClaimAt(index1: number): PendingClaim | undefined {
    const gone = this.claims()[index1 - 1];
    if (!gone) return undefined;
    const fresh = this.store.get().collab;
    this.store.update({
      collab: {
        ...fresh,
        pendingClaims: (fresh?.pendingClaims ?? []).filter((c) => c !== gone).slice(-CLAIMS_CAP),
        claimRejectedKeys: [...(fresh?.claimRejectedKeys ?? []), `${gone.roomId}|${gone.url}`].slice(-KEYS_CAP),
      },
    });
    return gone;
  }

  /** 认领成功后按房间移除(pmctl claim 确认路径;同房至多一条挂单)。 */
  removeClaimForRoom(roomId: string): void {
    const fresh = this.store.get().collab;
    this.store.update({
      collab: {
        ...fresh,
        pendingClaims: (fresh?.pendingClaims ?? []).filter((c) => c.roomId !== roomId).slice(-CLAIMS_CAP),
      },
    });
  }
}
