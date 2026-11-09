/**
 * RoomMailbox — 房间增量信箱(spec #299 票05)。
 *
 * "上下文全量共享,触发权分开"的承载件:房间可见文本(人类消息、bot 回复
 * 终文)凡未触发本 bot 的,进本房信箱;下一次触发(prompt)时以摘要并入并
 * 清空 —— 每次触发只带增量,上下文不随房间历史无界增长。
 *
 * 内存态即可:重启丢失由票08 的缺口声明兜底。只收斜杠命令以外的文本
 * (命令在解析阶段识别,进信箱会被两端重复执行)。
 */

/** 信箱条目上限:超限丢最旧并计数,缺口随下次触发一并声明。 */
export const MAILBOX_MAX_ITEMS = 20;

/** 单条文本上限:防单条超长消息独占信箱(超出截断)。 */
const MAILBOX_MAX_ITEM_CHARS = 500;

export interface MailboxDrain {
  /** 按到达序排列的可见文本行("用户名: 文本")。 */
  lines: string[];
  /** 因超限被丢弃的最旧条数。 */
  dropped: number;
}

export class RoomMailbox {
  private queues = new Map<string, { items: string[]; dropped: number }>();

  /** 收一条可见文本(超长截断;超限丢最旧并计数)。 */
  push(roomId: string, line: string): void {
    const queue = this.queues.get(roomId) ?? { items: [], dropped: 0 };
    queue.items.push(line.length > MAILBOX_MAX_ITEM_CHARS ? `${line.slice(0, MAILBOX_MAX_ITEM_CHARS)}…` : line);
    while (queue.items.length > MAILBOX_MAX_ITEMS) {
      queue.items.shift();
      queue.dropped += 1;
    }
    this.queues.set(roomId, queue);
  }

  /** 收一条可见文本并自带行格式(发送者: 文本)—— 格式所有权内聚在本模块,
   *  botFilter / guestTrigger 两个调用方不再各自拼串(票05 评审整改)。
   *  senderLabel 用 MXID(任务2 审计整改):displayname 任意可设会冒充他人;
   *  文本内换行转义为 ⏎,防单条消息伪造多行"别人说的"。 */
  pushVisible(roomId: string, senderLabel: string, text: string): void {
    this.push(roomId, `${senderLabel}: ${text.replace(/\r?\n/g, " ⏎ ")}`);
  }

  /** 清仓:取走全部增量;信箱空 = 无副作用(单 bot 房零变化)。 */
  drain(roomId: string): MailboxDrain {
    const queue = this.queues.get(roomId);
    if (!queue || queue.items.length === 0) return { lines: [], dropped: 0 };
    this.queues.delete(roomId);
    return { lines: queue.items, dropped: queue.dropped };
  }

  /** 退款:prompt 失败时把清仓的增量放回队首(保持到达序,dropped 计数并回)
   *  —— 与附件台账"失败不消耗,重试仍带上"同一消费语义(票05 评审整改)。
   *  放回后跑与 push 相同的封顶收敛(任务2 审计整改):drain 与 refund 之间
   *  的并发 push 可致超限,溢出丢弃计入 dropped。 */
  refund(roomId: string, drain: MailboxDrain): void {
    if (drain.lines.length === 0) return;
    const queue = this.queues.get(roomId) ?? { items: [], dropped: 0 };
    queue.items.unshift(...drain.lines);
    queue.dropped += drain.dropped;
    while (queue.items.length > MAILBOX_MAX_ITEMS) {
      queue.items.shift();
      queue.dropped += 1;
    }
    this.queues.set(roomId, queue);
  }
}
