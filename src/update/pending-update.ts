/**
 * pending-update.json —— /update 热更新的回执闭环(桥自更新 spec §5.6)。
 *
 * 换血完成后、触发重启「之前」写入 { from, to, startedAt };新进程启动时消费:
 * 向管理房发「更新完成 vX→vY」回执并销账。consume-once 先例照
 * src/rpc/queue-snapshots.ts(loadValid 过滤畸形 → 消费 → clear):错过一条
 * 通知好过永远重试 —— 发送失败也照旧销账,仅 warn 留痕。
 *
 * 写侧刻意不走 JsonStateFile.save 的吞错契约(src/state/json-file.ts:68-92
 * catch → warn 永不抛 —— 那是状态文件「磁盘是备份」的降级语义):本文件是
 * 回执闭环的唯一凭据,写失败必须可感知 —— 照旧触发重启会让回执静默丢失,
 * 恰是「先写文件再重启」这一顺序要防的事故(§5.5 步骤 1)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AUDIT_EVENTS } from "../audit/audit-log.js";
import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import { JsonStateFile } from "../state/json-file.js";
import { readBridgeVersion } from "../version.js";

export interface PendingUpdateEntry {
  from: string;
  to: string;
  startedAt: number;
}

// 防注入(§5.2 同一格式):版本号要拼进回执文案,格式不过 = 视作无更新。
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export class PendingUpdateStore {
  private readonly file: JsonStateFile<PendingUpdateEntry | null>;

  constructor(private readonly filePath: string) {
    // 读侧经 JsonStateFile(fallback null = 无待处理更新)吃「磁盘是备份」
    // 的吞错降级 —— 缺文件/坏 JSON 静默回 null,不阻塞启动。
    this.file = new JsonStateFile<PendingUpdateEntry | null>(filePath, null);
  }

  /** 有效条目;无文件 → undefined;条目畸形(缺字段/版本格式不过)→ warn
   *  留痕并视作无更新(同 queue-snapshots 的 isValidEntry 保守路线)。 */
  read(): PendingUpdateEntry | undefined {
    const raw = this.file.load();
    if (raw === null) return undefined;
    if (
      typeof raw.from !== "string" ||
      typeof raw.to !== "string" ||
      !VERSION_RE.test(raw.from) ||
      !VERSION_RE.test(raw.to) ||
      typeof raw.startedAt !== "number"
    ) {
      logger.warn(`pending-update.json malformed, treating as no pending update: ${this.filePath}`);
      return undefined;
    }
    return { from: raw.from, to: raw.to, startedAt: raw.startedAt };
  }

  /**
   * 可感知写(§5.5 步骤 1):原子写(tmp + rename,0600/0700,形态同
   * JsonStateFile.save)但失败上抛 —— 调用方(重启编排)据此放弃自动重启,
   * 降级手动重启回执。0700 只在目录被创建时生效;已存在的松散目录单独收紧,
   * 收紧失败不影响本次落盘。
   */
  write(entry: PendingUpdateEntry): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.unlinkSync(tmp);
    } catch {
      // absent tmp is the normal case
    }
    fs.writeFileSync(tmp, JSON.stringify(entry, undefined, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(path.dirname(this.filePath), 0o700);
    } catch {
      // 权限收紧失败不影响本次落盘
    }
  }

  /** 销账 = 文件消失(consume-once)。尽力而为:unlink 失败仅 warn ——
   *  下次启动会重复消费一次,与 queue-snapshots.clear 同级风险,可接受。 */
  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`pending-update.json clear failed: ${errorMessage(err)}`);
      }
    }
  }
}

export interface PendingUpdateConsumer {
  /** 原始 transport 发送(失败抛错;这里按 consume-once 吞掉留痕)。 */
  send: (roomId: string, text: string) => Promise<void>;
  /** 审计缝(AuditLog.append 同参)。 */
  audit: (event: string, actor: string, chatId: string, detail?: string) => void;
  /** 管理房 id;undefined = 单工程部署(无管理房)→ 跳过发送。 */
  managementRoomId?: string;
  /** 磁盘实际版本缝(默认 readBridgeVersion)。 */
  readVersion?: () => string | undefined;
}

/**
 * 启动期消费(standalone 组合根调用一次,matrix isConnected 前置同队列快照):
 * 有效条目 → 文案以磁盘实际版本为准(≠ 预期 to 时追加不一致警告)→
 * best-effort 发送 → 无论发送成败都落 audit update.done(actor "system",
 * chatId = 投递目标或空串)→ store.clear() 销账。
 */
export function consumePendingUpdate(store: PendingUpdateStore, consumer: PendingUpdateConsumer): void {
  const entry = store.read();
  if (!entry) return;
  const actual = (consumer.readVersion ?? readBridgeVersion)();
  let text = t("cmd.update.done", { from: entry.from, to: entry.to });
  if (actual !== entry.to) {
    text += `\n${t("cmd.update.doneVersionMismatch", { actual: actual ?? "unknown", to: entry.to })}`;
  }
  if (consumer.managementRoomId) {
    const roomId = consumer.managementRoomId;
    void consumer.send(roomId, text).catch((err: unknown) => {
      logger.warn(`pending-update notice failed for ${roomId} — consumed anyway: ${errorMessage(err)}`);
    });
  } else {
    // 单工程:managementRoomId 为 undefined(管理房收养只在多工程发生),
    // 且新进程没有「发起房间」上下文、单工程房间绑定是运行时 DM 不可猜
    // —— 跳过发送,审计照落、照旧销账、warn 留痕。替代面是重启前的
    // cmd.update.restarting 回执(发起房间)与日志。
    logger.warn("pending-update consumed in single-project mode: completion notice skipped (no management room)");
  }
  consumer.audit(
    AUDIT_EVENTS.updateDone,
    "system",
    consumer.managementRoomId ?? "",
    `v${entry.from} → v${entry.to} (disk v${actual ?? "unknown"})`
  );
  store.clear();
}
