/**
 * Reminder time parsing (issue #117) — deliberately NOT natural language:
 * a reminder that fires at a surprising time is worse than one that refuses
 * to parse. v1 accepts exactly three deterministic formats:
 *   duration  30m / 90m / 2h / 1d
 *   HH:MM     today if still ahead, otherwise tomorrow (local time)
 *   ISO       2026-10-09T09:00 (local), with seconds or Z suffix also fine
 */

/** Duration unit → ms. */
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

const DURATION = /^(\d+)(m|h|d)$/;
const WALL_CLOCK = /^(\d{1,2}):(\d{2})$/;

/**
 * Parse one reminder time against `now` (epoch ms). Returns the due time in
 * epoch ms, or null when the input matches none of the three formats (or
 * resolves to the past).
 */
export function parseReminderTime(input: string, now: number): number | null {
  const text = input.trim();
  if (!text) return null;

  const duration = DURATION.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount === 0) return null;
    return now + amount * UNITS[duration[2]!];
  }

  const wallClock = WALL_CLOCK.exec(text);
  if (wallClock) {
    const hour = Number(wallClock[1]);
    const minute = Number(wallClock[2]);
    if (hour > 23 || minute > 59) return null;
    const due = new Date(now);
    due.setHours(hour, minute, 0, 0);
    if (due.getTime() <= now) due.setDate(due.getDate() + 1);
    return due.getTime();
  }

  const iso = Date.parse(text);
  if (!Number.isNaN(iso) && iso > now) return iso;
  return null;
}

/** Deterministic local-time render for confirmations and lists: YYYY-MM-DD HH:MM. */
export function formatReminderTime(dueAt: number): string {
  const due = new Date(dueAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${pad(due.getHours())}:${pad(due.getMinutes())}`;
}
