/**
 * Reminder clock (issue #117): the scheduler half of /remind. Design rules:
 * - Disk is the truth, the timer is a handle: setTimeout handles don't
   survive a process, the persisted store does — start() reloads and re-arms.
 * - Overdue reminders on startup are delivered immediately with a late note
   (at most lateCap; the rest are dropped with one summary per room — a
   month-long outage must not fire 500 pings at the poor user).
 * - Node clamps setTimeout at 2^31-1 ms (~24.8 days): longer leads are armed
   in chunks and re-checked on each fire, so a reminder 3 months out still
   fires exactly once, on time.
 */

import { errorMessage } from "../errors.js";
import { t } from "../i18n/index.js";
import { logger } from "../logger.js";
import type { ReminderEntry, ReminderStore } from "./reminder-store.js";

/** Node's setTimeout ceiling: delays beyond this are armed in chunks. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Startup catch-up: never deliver more than this many overdue reminders. */
const LATE_DELIVERY_CAP = 50;
/** A tick delivery later than this counts as late (startup catch-up is
 *  always late; timer fires drift by milliseconds only). */
const LATE_THRESHOLD_MS = 60_000;

export interface ReminderDelivery {
  chatId: string;
  transport: string;
  text: string;
}

export interface ReminderController {
  /** Add + arm. False = room cap reached (caller replies with the refusal). */
  add(input: { chatId: string; transport: string; userId: string; username: string; text: string; dueAt: number }): boolean;
  listForRoom(chatId: string): ReminderEntry[];
  /** Remove the n-th (1-based) reminder of this room's list; undefined when
   *  the 序号 doesn't exist. */
  removeByIndex(chatId: string, index: number): ReminderEntry | undefined;
}

export class ReminderClock implements ReminderController {
  private timer: NodeJS.Timeout | undefined;
  private readonly lateCap: number;

  constructor(
    private readonly store: ReminderStore,
    private readonly deliver: (delivery: ReminderDelivery) => Promise<void> | void,
    opts: { lateCap?: number } = {}
  ) {
    this.lateCap = opts.lateCap ?? LATE_DELIVERY_CAP;
  }

  /** Startup: reload the store, catch up on overdue, arm the next timer. */
  async start(): Promise<void> {
    this.store.load();
    const now = Date.now();
    const overdue = this.store.due(now);
    if (overdue.length === 0) {
      this.arm();
      return;
    }
    logger.info(`reminders: ${overdue.length} overdue while offline — catching up`);
    const deliverable = overdue.slice(0, this.lateCap);
    const dropped = overdue.slice(this.lateCap);
    for (const entry of deliverable) {
      await this.deliverEntry(entry, now);
    }
    if (dropped.length > 0) {
      const byRoom = new Map<string, ReminderEntry[]>();
      for (const entry of dropped) {
        byRoom.set(entry.chatId, [...(byRoom.get(entry.chatId) ?? []), entry]);
      }
      for (const [chatId, entries] of byRoom) {
        await this.safeDeliver({
          chatId,
          transport: entries[0]!.transport,
          text: t("remind.dropped", { count: entries.length }),
        });
      }
    }
    this.arm();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  add(input: { chatId: string; transport: string; userId: string; username: string; text: string; dueAt: number }): boolean {
    const added = this.store.add(input);
    if (added) this.arm();
    return added;
  }

  listForRoom(chatId: string): ReminderEntry[] {
    return this.store.listForRoom(chatId);
  }

  removeByIndex(chatId: string, index: number): ReminderEntry | undefined {
    const roomList = this.store.listForRoom(chatId);
    const entry = roomList[index - 1];
    if (!entry) return undefined;
    const removed = this.store.remove(entry.id);
    if (removed) this.arm();
    return removed;
  }

  /** Room-death cleanup (/pmctl rm): drop the room's reminders, re-arm, and
   *  return how many went away. */
  purgeRoom(chatId: string): number {
    const purged = this.store.purgeRoom(chatId);
    if (purged > 0) this.arm();
    return purged;
  }

  /** Arm exactly one timer for the earliest future reminder (chunked at
   *  Node's setTimeout ceiling). No timer when nothing is pending. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.store.list().find((entry) => entry.dueAt > Date.now());
    if (!next) return;
    const delay = Math.min(next.dueAt - Date.now(), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    const now = Date.now();
    // Chunked arms can fire early (ceiling reached before dueAt): whatever is
    // still future stays in the store and re-arms.
    for (const entry of this.store.due(now)) {
      await this.deliverEntry(entry, now);
    }
    this.arm();
  }

  /** Deliver + remove from the store. Late note when the fire slipped. */
  private async deliverEntry(entry: ReminderEntry, now: number): Promise<void> {
    const slip = now - entry.dueAt;
    const late = slip >= LATE_THRESHOLD_MS ? t("remind.late", { minutes: Math.max(1, Math.round(slip / 60_000)) }) : "";
    await this.safeDeliver({
      chatId: entry.chatId,
      transport: entry.transport,
      text: t("remind.due", { user: entry.username, text: entry.text }) + (late ? `\n${late}` : ""),
    });
    this.store.remove(entry.id);
  }

  private async safeDeliver(delivery: ReminderDelivery): Promise<void> {
    try {
      await this.deliver(delivery);
    } catch (err) {
      logger.warn(`reminder delivery failed: ${errorMessage(err)}`);
    }
  }
}
