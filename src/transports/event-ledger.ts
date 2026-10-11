/**
 * 已处理事件台账(issue #113 离线收件箱):把「stale = 丢」升级为「stale =
 * 查台账」的另一半 —— 每条真正受理过的 Matrix 事件记一行 JSONL,重启后
 * stale 且台账未见过的 = 离线积压,交给 router 征询,不再无声蒸发。
 *
 * 磁盘形态(~/.pi/pi-courier-state/event-ledger.jsonl,0600):每行一条
 * `{"id":"$…","ts":…}`;首行 `{"init":<首运时刻>}` 标记台账诞生 —— 文件不
 * 存在的首个会话里 stale 一律维持全丢(全新部署/升级首启的初始同步回放
 * 无法与真积压区分),只从实时事件开始记账;自第二个会话起查台账。
 *
 * 容错与 ConfigStore/JsonStateFile 同哲学:坏行跳过、读失败视为首运(宁可
 * 本轮多丢、不可把历史回放误判成积压自动执行)、追加失败仅 warn(内存仍是
 * 权威)。台账有界:启动压实一次,只保留最近 7 天(常数,不进配置)。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../errors.js";
import { logger } from "../logger.js";

/** 台账保留窗:只回答「最近见过没有」,更久的历史没有查询价值。 */
export const EVENT_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface EventLedger {
  /** true = 本会话是台账首运(文件不存在/读不出):stale 一律维持丢弃 ——
   *  初始同步回放无法与真积压区分,宁丢不误。 */
  readonly freshStart: boolean;
  /** 该事件此前是否受理过(重启前记下的账)。 */
  seen(eventId: string): boolean;
  /** 记账:内存 Set 立即生效 + JSONL 追加(fire-and-forget,失败仅 warn)。 */
  record(eventId: string): void;
}

interface LedgerLine {
  id?: unknown;
  ts?: unknown;
  init?: unknown;
}

export class FileEventLedger implements EventLedger {
  private readonly seenIds = new Set<string>();
  /** true = 启动时台账不存在(或读不出):本会话 stale 维持全丢(等价现状)。 */
  readonly freshStart: boolean;
  private readonly retentionMs: number;

  constructor(
    private readonly filePath: string,
    opts: { retentionMs?: number } = {}
  ) {
    this.retentionMs = opts.retentionMs ?? EVENT_LEDGER_RETENTION_MS;
    const loaded = this.load();
    this.freshStart = loaded === null;
    if (loaded === null) {
      this.writeInit();
    } else {
      this.compact(loaded.entries, loaded.keepInit);
    }
  }

  seen(eventId: string): boolean {
    return this.seenIds.has(eventId);
  }

  record(eventId: string): void {
    this.seenIds.add(eventId);
    const line = JSON.stringify({ id: eventId, ts: Date.now() }) + "\n";
    appendFile(this.filePath, line).catch((err: unknown) => {
      logger.warn(`event ledger append failed (memory stays authoritative): ${errorMessage(err)}`);
    });
  }

  /** 启时装载:返回 null = 文件不存在/读不出(按首运处理)。坏行静默跳过。 */
  private load(): { entries: Array<{ id: string; ts: number }>; keepInit: boolean } | null {
    if (!existsSync(this.filePath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err: unknown) {
      logger.warn(`event ledger unreadable, treating this session as first run: ${errorMessage(err)}`);
      return null;
    }
    const entries: Array<{ id: string; ts: number }> = [];
    let keepInit = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: LedgerLine;
      try {
        parsed = JSON.parse(trimmed) as LedgerLine;
      } catch {
        continue; // 手编/中断写的半行:跳过,不炸启动
      }
      if (parsed.init !== undefined) {
        keepInit = true;
        continue;
      }
      if (typeof parsed.id === "string" && parsed.id && typeof parsed.ts === "number") {
        entries.push({ id: parsed.id, ts: parsed.ts });
      }
    }
    return { entries, keepInit };
  }

  /** 启动压实:整文件重写一次,只留保留窗内的记录(原子写,tmp+rename)。 */
  private compact(entries: Array<{ id: string; ts: number }>, keepInit: boolean): void {
    const cutoff = Date.now() - this.retentionMs;
    const kept = entries.filter((e) => e.ts >= cutoff);
    this.seenIds.clear();
    for (const e of kept) this.seenIds.add(e.id);
    const dropped = entries.length - kept.length;
    const lines = kept.map((e) => JSON.stringify({ id: e.id, ts: e.ts }));
    if (keepInit || lines.length === 0) lines.unshift(JSON.stringify({ init: Date.now() }));
    try {
      const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.tmp`);
      writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err: unknown) {
      logger.warn(`event ledger compaction failed (continuing with loaded state): ${errorMessage(err)}`);
    }
    if (dropped > 0) {
      logger.info(`event ledger compacted: dropped ${dropped} record(s) older than the retention window`);
    }
  }

  private writeInit(): void {
    this.seenIds.clear();
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify({ init: Date.now() }) + "\n", { mode: 0o600 });
    } catch (err: unknown) {
      logger.warn(`event ledger init write failed: ${errorMessage(err)}`);
    }
  }
}
