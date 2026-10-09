/**
 * Reminder time parsing (issue #117): deterministic formats only — duration,
 * wall-clock HH:MM (today→tomorrow rollover), ISO. Every case pins the exact
 * epoch ms against a fixed `now`, so DST/ TZ surprises surface as failures.
 */
import { describe, expect, it } from "vitest";
import { formatReminderTime, parseReminderTime } from "../src/reminders/reminder-parse";

// 2026-10-08 10:00:00 local — arbitrary but fixed.
const NOW = new Date(2026, 9, 8, 10, 0, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("parseReminderTime (issue #117)", () => {
  it("durations: m/h/d from now", () => {
    expect(parseReminderTime("30m", NOW)).toBe(NOW + 30 * MIN);
    expect(parseReminderTime("90m", NOW)).toBe(NOW + 90 * MIN);
    expect(parseReminderTime("2h", NOW)).toBe(NOW + 2 * HOUR);
    expect(parseReminderTime("1d", NOW)).toBe(NOW + DAY);
    expect(parseReminderTime("  5m ", NOW)).toBe(NOW + 5 * MIN); // trimmed
  });

  it("durations: zero and garbage are rejected", () => {
    expect(parseReminderTime("0m", NOW)).toBeNull();
    expect(parseReminderTime("0h", NOW)).toBeNull();
    expect(parseReminderTime("-5m", NOW)).toBeNull();
    expect(parseReminderTime("5x", NOW)).toBeNull();
    expect(parseReminderTime("m", NOW)).toBeNull();
    expect(parseReminderTime("abc", NOW)).toBeNull();
    expect(parseReminderTime("", NOW)).toBeNull();
    expect(parseReminderTime("   ", NOW)).toBeNull();
  });

  it("HH:MM still ahead today → today", () => {
    expect(parseReminderTime("11:30", NOW)).toBe(new Date(2026, 9, 8, 11, 30).getTime());
    expect(parseReminderTime("9:05", NOW)).toBe(new Date(2026, 9, 8, 9, 5).getTime() + DAY); // 09:05 already passed → tomorrow
    expect(parseReminderTime("23:59", NOW)).toBe(new Date(2026, 9, 8, 23, 59).getTime());
  });

  it("HH:MM already past (or this same minute) → tomorrow", () => {
    expect(parseReminderTime("09:30", NOW)).toBe(new Date(2026, 9, 9, 9, 30).getTime());
    expect(parseReminderTime("10:00", NOW)).toBe(new Date(2026, 9, 9, 10, 0).getTime()); // boundary: rolls over
    expect(parseReminderTime("00:00", NOW)).toBe(new Date(2026, 9, 9, 0, 0).getTime());
  });

  it("HH:MM invalid values are rejected", () => {
    expect(parseReminderTime("24:00", NOW)).toBeNull();
    expect(parseReminderTime("12:60", NOW)).toBeNull();
    expect(parseReminderTime("12:5", NOW)).toBeNull();
    expect(parseReminderTime("ab:cd", NOW)).toBeNull();
  });

  it("ISO datetimes in the future are accepted (local and Z)", () => {
    expect(parseReminderTime("2026-10-09T09:00", NOW)).toBe(new Date(2026, 9, 9, 9, 0).getTime());
    expect(parseReminderTime("2026-10-08T10:00:30", NOW)).toBe(NOW + 30_000);
    const zulu = parseReminderTime("2026-10-09T00:00Z", NOW);
    expect(zulu).not.toBeNull();
    expect(zulu!).toBe(Date.parse("2026-10-09T00:00Z"));
  });

  it("ISO in the past (or unparseable) is rejected", () => {
    expect(parseReminderTime("2026-10-08T09:00", NOW)).toBeNull();
    expect(parseReminderTime("2020-01-01T00:00Z", NOW)).toBeNull();
    expect(parseReminderTime("not a date", NOW)).toBeNull();
  });
});

describe("formatReminderTime (issue #117)", () => {
  it("renders YYYY-MM-DD HH:MM in local time with zero padding", () => {
    expect(formatReminderTime(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
    expect(formatReminderTime(new Date(2026, 11, 31, 23, 59).getTime())).toBe("2026-12-31 23:59");
  });
});
