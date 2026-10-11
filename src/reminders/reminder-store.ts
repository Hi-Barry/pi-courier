/**
 * Reminder persistence (issue #117): a thin domain layer over JsonStateFile.
 * The store owns the in-memory list; every mutation rewrites the file, so a
 * crash at any moment loses at most the reminder being added — the disk copy
 * is what a fresh process loads (ReminderClock.start).
 */

import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type { JsonStateFile } from "../state/json-file.js";

export interface ReminderEntry {
  /** Short id (list rendering never shows it; rm works by 序号). */
  id: string;
  chatId: string;
  transport: string;
  /** Who set it — the delivery mentions this person. */
  userId: string;
  username: string;
  text: string;
  /** Epoch ms. */
  dueAt: number;
  createdAt: number;
}

/** One room may hold at most this many active reminders (anti-runaway). */
export const MAX_REMINDERS_PER_ROOM = 20;

export class ReminderStore {
  private entries: ReminderEntry[] = [];

  constructor(private readonly file: JsonStateFile<ReminderEntry[]>) {}

  /** Load from disk (clock startup). Corrupt/missing file → empty, per the
   *  JsonStateFile contract. Entry-level shape guard (audit stability batch
   *  票17): malformed entries are dropped with a warning instead of blowing
   *  up the clock later. */
  load(): void {
    const loaded = this.file.load();
    const valid = loaded.filter(
      (e) =>
        typeof e?.id === "string" &&
        typeof e?.chatId === "string" &&
        typeof e?.transport === "string" &&
        typeof e?.userId === "string" &&
        typeof e?.username === "string" &&
        typeof e?.text === "string" &&
        Number.isFinite(e?.dueAt) &&
        Number.isFinite(e?.createdAt)
    );
    if (valid.length !== loaded.length) {
      logger.warn(`reminder store: dropped ${loaded.length - valid.length} malformed entr(ies) from disk`);
    }
    this.entries = valid;
  }

  /** Active reminders, earliest due first. */
  list(): ReminderEntry[] {
    return [...this.entries].sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
  }

  listForRoom(chatId: string): ReminderEntry[] {
    return this.list().filter((entry) => entry.chatId === chatId);
  }

  countForRoom(chatId: string): number {
    return this.entries.filter((entry) => entry.chatId === chatId).length;
  }

  /** Add and persist. False when the room hit its cap — the caller turns that
   *  into a polite refusal; the store never silently drops. */
  add(entry: Omit<ReminderEntry, "id" | "createdAt">): boolean {
    if (this.countForRoom(entry.chatId) >= MAX_REMINDERS_PER_ROOM) return false;
    this.entries.push({ ...entry, id: randomUUID().slice(0, 8), createdAt: Date.now() });
    this.persist();
    return true;
  }

  remove(id: string): ReminderEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return undefined;
    const [removed] = this.entries.splice(index, 1);
    this.persist();
    return removed;
  }

  /** Room-death cleanup (/pmctl rm): drop every reminder of one room and
   *  persist. Unfulfillable intent should not wait out the clock — returns
   *  how many were removed. */
  purgeRoom(chatId: string): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.chatId !== chatId);
    const removed = before - this.entries.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Everything due at or before `now` (clock tick / startup catch-up). */
  due(now: number): ReminderEntry[] {
    return this.list().filter((entry) => entry.dueAt <= now);
  }

  private persist(): void {
    this.file.save(this.entries);
  }
}
