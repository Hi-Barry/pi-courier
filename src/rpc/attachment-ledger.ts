/**
 * Pending-attachment ledger (issue #66 票1 park/consume, issue #114 disk
 * backup): 按「房间+发送者」记停在途附件,同一发送者的下一条对话消息
 * (prompt 唯一注入点)一次性带上全部。磁盘只做备份,内存 Map 仍是唯一
 * 热路径(ConfigStore 单写者哲学);注入 JsonStateFile 则启动装载一次
 * (24h TTL,过期/残缺条目静默跳过),每次变更原子落盘,写失败仅 warn
 * (内存仍是权威,退回 0.3.8 行为)。不注入 = 纯内存,行为与 0.3.8
 * 逐字节一致。
 *
 * 2026-10-27 扫描批次 A:自此自 message-router 出门(与 BacklogInbox /
 * ExtensionQuestions / RecapLedger 同构的第三态)——TTL、\u0000 键编码、
 * 落盘形状收进一个 module,router 三阶段只调用;测试从 router 全家桶
 * 变 module 直测。
 */

import type { JsonStateFile } from "../state/json-file.js";
import { logger } from "../logger.js";
import type { MessageAttachment } from "../types.js";

/** 房间+发送者 → 账本键。`\u0000` 作分隔:两个分量都不会含它,拆分无歧义。 */
export function attachmentLedgerKey(chatId: string, userId: string): string {
  return `${chatId}\u0000${userId}`;
}

/** Disk shape of one pending-attachment entry (issue #114). An array of
 *  entries — not a keyed map — keeps the `\u0000` ledger-key separator out of
 *  JSON object keys, where it would be hostile to hand editing and to some
 *  JSON tooling. */
export interface PersistedAttachmentEntry {
  chatId: string;
  userId: string;
  /** Epoch ms when the first attachment for this room+sender was parked —
   *  drives the 24h TTL on load. */
  at: number;
  attachments: MessageAttachment[];
}

/** 首次停车到装载的存活上限:挂了 24h 没被消费的条目在下次启动装载时过期
 *  (运行中不计时 —— 落盘 TTL 只在装载时裁决,issue #114 定的形态)。 */
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export class AttachmentLedger {
  private pending = new Map<string, MessageAttachment[]>();
  /** 首次停车时间(落盘 TTL 的依据,issue #114):只记第一次,后来追加的
   *  附件不顺延。 */
  private parkedAt = new Map<string, number>();

  constructor(private readonly ledger?: JsonStateFile<PersistedAttachmentEntry[]>) {
    if (!this.ledger) return;
    const now = Date.now();
    let restored = 0;
    for (const entry of this.ledger.load()) {
      if (!entry || typeof entry.chatId !== "string" || typeof entry.userId !== "string") continue;
      if (!Array.isArray(entry.attachments) || entry.attachments.length === 0) continue;
      if (typeof entry.at !== "number" || now - entry.at > LEDGER_TTL_MS) continue;
      this.pending.set(attachmentLedgerKey(entry.chatId, entry.userId), entry.attachments);
      this.parkedAt.set(attachmentLedgerKey(entry.chatId, entry.userId), entry.at);
      restored += entry.attachments.length;
    }
    if (restored > 0) {
      logger.info(
        `restored ${restored} parked attachment(s) across ${this.pending.size} room+sender entries from disk`
      );
    }
  }

  /** 停车:该发送者的清单追加 N 个附件并原子落盘;首停时间只记第一次。 */
  park(chatId: string, userId: string, attachments: MessageAttachment[]): void {
    const key = attachmentLedgerKey(chatId, userId);
    const list = this.pending.get(key) ?? [];
    for (const attachment of attachments) list.push(attachment);
    this.pending.set(key, list);
    this.parkedAt.set(key, this.parkedAt.get(key) ?? Date.now());
    this.persist();
  }

  /** 非破坏性读取:该发送者当前停车的全部附件。undefined = 无停车。
   *  消费是两段式 —— prompt 成功才 release(失败不消耗,重试仍带上),
   *  这条纪律由调用方持有,peek 不动账。 */
  peek(chatId: string, userId: string): MessageAttachment[] | undefined {
    const carried = this.pending.get(attachmentLedgerKey(chatId, userId));
    return carried?.length ? carried : undefined;
  }

  /** 消费清账:prompt 成功后调用,清空该发送者条目并原子落盘。 */
  release(chatId: string, userId: string): void {
    const key = attachmentLedgerKey(chatId, userId);
    if (!this.pending.delete(key)) return;
    this.parkedAt.delete(key);
    this.persist();
  }

  /** 房间销账(/pmctl rm 确认后):清掉该房间全部停车附件并落盘,返回
   *  条数。房间删除后其清单条目已无人能消费 —— 意图随房间销账,不等
   *  24h TTL 自然过期。 */
  purgeRoom(roomId: string): number {
    let removed = 0;
    for (const key of [...this.pending.keys()]) {
      if (key.slice(0, key.indexOf("\u0000")) === roomId) {
        this.pending.delete(key);
        this.parkedAt.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  /** 变更后原子落盘;无账本(纯内存形态)为 no-op。 */
  private persist(): void {
    if (!this.ledger) return;
    const entries: PersistedAttachmentEntry[] = [];
    for (const [key, attachments] of this.pending) {
      const sep = key.indexOf("\u0000");
      if (sep <= 0) continue; // malformed key never reaches disk
      entries.push({
        chatId: key.slice(0, sep),
        userId: key.slice(sep + 1),
        at: this.parkedAt.get(key) ?? Date.now(),
        attachments,
      });
    }
    this.ledger.save(entries);
  }
}
