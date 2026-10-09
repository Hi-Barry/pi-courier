/**
 * Reminder persistence (issue #117): a thin domain layer over JsonStateFile.
 * The store owns the in-memory list; every mutation rewrites the file, so a
 * crash at any moment loses at most the reminder being added — the disk copy
 * is what a fresh process loads (ReminderClock.start).
 */

import { randomUUID } from "node:crypto";
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
   *  JsonStateFile contract. */
  load(): void {
    this.entries = this.file.load();
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

  /** Everything due at or before `now` (clock tick / startup catch-up). */
  due(now: number): ReminderEntry[] {
    return this.list().filter((entry) => entry.dueAt <= now);
  }

  private persist(): void {
    this.file.save(this.entries);
  }
}
