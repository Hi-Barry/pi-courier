/**
 * 组合根的启动状态(spec #99 票7 / issue #106):把 standalone.ts 组合根里
 * 三块无处归属的启动期状态收编成一个可注入、可单测的模块。
 *
 * 1. 配对码去向(pairing sink):ChallengeAuth 的回调在组合根最早期构造,
 *    而落地目标(sendReply → 管理房间)要等 transport 接线完成后才存在。
 *    过去靠 `let sendPairingNotice | undefined` 加「回调不可能在接线完成
 *    前触发」的注释保证安全 —— 时序知识没有结构支撑(历史教训:同文件的
 *    内层 const 遮蔽曾让接线静默失效,真机冒烟才抓到)。现在模块持槽:
 *    回调从第一天指向已构造的本模块;一律入队按序发出,接线前滞留缓冲,
 *    接线后补发 —— 接线前到达也不丢,发出失败也不丢(置顶保留随队重试)。
 * 2. 收养许可:空间模式(multi-project + space.enabled)下,首个 DM 的
 *    收养默认保留给 bot 自建管理房;空间 ensure 降级的运行里重新开放。
 *    两态旗标从组合根闭包移入本模块,`allowAdoption()` 是唯一翻转口,
 *    router 经注入的查询只读。
 * 3. 启动自愈编排:`runStartupHeals` 自 space.ts 迁入(票4 预留),固定
 *    顺序 信任补权 → 房间身份 → bot 头像;三段深函数仍在 space.ts。
 */

import { type ConfigStore, isSpaceMode, managementRoomId } from "./config.js";
import { logger } from "./logger.js";
import { healBotAvatar, healRoomIdentities, healTrustedPowerLevels } from "./space.js";
import type { RoomOps } from "./transports/interface.js";

/** 组合根 sendReply 的形状(接线时由组合根交入)。 */
export type PairingSink = (chatId: string, transport: string, text: string) => Promise<void>;

export interface StartupStateDeps {
  /** 单一运行时配置读写路径:配对码去向的管理房判定与收养初值都经它读。 */
  store: ConfigStore;
}

export interface StartupState {
  /** 配对码落地(ChallengeAuth 回调从第一天就调这里):一律入缓冲队列按序
   *  发出;接线前滞留缓冲,发出失败置顶保留待下次随队重试。 */
  sendPairingNotice(text: string): Promise<void>;
  /** 组合根接线:写入落地目标并按到达顺序补发缓冲。首次接线生效,重复
   *  调用幂等忽略;返回的 Promise 在补发完成后 resolve。 */
  wirePairingSink(sink: PairingSink): Promise<void>;
  /** 空间 ensure 降级时调用:重新开放 DM 收养(唯一翻转口)。 */
  allowAdoption(): void;
  /** router managementAdoption 阶段注入的只读查询。 */
  managementRoomAdoptionAllowed(): boolean;
}

export function createStartupState(deps: StartupStateDeps): StartupState {
  const { store } = deps;

  // 配对码槽:一律先入缓冲队列再按序发出 —— 接线前只是不发出(安全网),
  // 接线后补发。发出失败(假 sink 抛错;生产 sendReply 自吞错,此路径实际
  // 不可达)时该条置顶保留、停止本次补发,下一条配对码到达时随队重试 ——
  // 「不丢、按到达顺序」在任何失败模式下都成立(评审修复:原 while+shift
  // 在 deliver reject 时丢已 shift 项且余项永久滞留)。
  const pending: string[] = [];
  let sink: PairingSink | undefined;

  // 收养许可初值:空间模式不放行(管理房留给自建),非空间模式即放行 ——
  // 与原组合根 `!spaceEnabled` 同值,只是「空间是否降级」这个状态有了归属。
  let adoptionAllowed = !isSpaceMode(store.get());

  const deliver = (via: PairingSink, text: string): Promise<void> => {
    // 管理房是 Matrix 房间 ID(收养与自建都只发生在 matrix transport 上),
    // 与原组合根闭包一致地硬编码渠道;去向由 config 派生,无管理房则静默
    // (配对码本就有仅日志的兜底,见 ChallengeAuth 回调)。
    const mgmtRoom = managementRoomId(store.get());
    return mgmtRoom ? via(mgmtRoom, "matrix", text) : Promise.resolve();
  };

  // 按序补发:首条失败即停并置顶保留(保序),不抛 —— 补发失败不改变调用
  // 方时序,重试搭下一条配对码的便车。
  const drain = async (): Promise<void> => {
    while (sink && pending.length > 0) {
      const text = pending[0]!;
      try {
        await deliver(sink, text);
      } catch (err) {
        logger.warn(`[startup] 配对码发出失败,保留缓冲待下次尝试: ${(err as Error).message}`);
        return;
      }
      pending.shift();
    }
  };

  return {
    sendPairingNotice(text: string): Promise<void> {
      pending.push(text);
      if (!sink) {
        logger.debug("[startup] 配对码在接线前到达,已缓冲(接线后补发)");
        return Promise.resolve();
      }
      return drain();
    },

    wirePairingSink(wired: PairingSink): Promise<void> {
      if (sink) return Promise.resolve();
      sink = wired;
      return drain();
    },

    allowAdoption(): void {
      adoptionAllowed = true;
    },

    managementRoomAdoptionAllowed(): boolean {
      return adoptionAllowed;
    },
  };
}

/** 组合根的整段启动自愈序列(编排单点,票7 自 space.ts 迁入),固定顺序:
 *  信任用户补权(空间 + 降级两模式)→ 房间身份自愈(仅空间模式)→ bot
 *  头像(所有模式)。各段在内部 best-effort —— 不抛错、不触碰启动结果
 *  三态。预期 404 未命中已在 RoomOps 适配器内部安静(matrix-rooms.ts),
 *  这里无需任何抑制窗口。 */
export async function runStartupHeals(roomOps: RoomOps, store: ConfigStore): Promise<void> {
  await healTrustedPowerLevels(roomOps, store);
  await healRoomIdentities(roomOps, store);
  await healBotAvatar(roomOps, store);
}
