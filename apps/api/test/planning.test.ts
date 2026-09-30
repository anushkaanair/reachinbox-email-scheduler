import { describe, expect, it } from 'vitest';
import {
  isInSendWindow,
  nextSendWindowStart,
  SendWindowSchema,
  sendWindowIntervals,
  zonedParts,
  zonedTimeToUtc,
  type SendWindow,
} from '@ri/shared';
import { forecast, scheduleTimes } from '../src/modules/campaigns/planning.js';

const NY: SendWindow = { startHour: 9, endHour: 17, timezone: 'America/New_York', weekdaysOnly: true };
const IST: SendWindow = { startHour: 9, endHour: 18, timezone: 'Asia/Kolkata', weekdaysOnly: false };
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const HOUR = 3_600_000;

// 2026-09-29 is a Tuesday; 2026-10-02 a Friday; DST in the US ends Sunday 2026-11-01.

describe('time zone maths', () => {
  it('reads wall-clock parts in a zone (incl. half-hour offsets)', () => {
    expect(zonedParts(utc(2026, 9, 29, 20, 0), 'America/New_York')).toMatchObject({ hour: 16, weekday: 2 });
    expect(zonedParts(utc(2026, 9, 29, 3, 30), 'Asia/Kolkata')).toMatchObject({ hour: 9, minute: 0 });
  });

  it('converts a local wall-clock time back to the right instant, across DST', () => {
    expect(zonedTimeToUtc(2026, 9, 30, 9, 'America/New_York')).toBe(utc(2026, 9, 30, 13)); // EDT = UTC-4
    expect(zonedTimeToUtc(2026, 11, 2, 9, 'America/New_York')).toBe(utc(2026, 11, 2, 14)); // EST = UTC-5
    expect(zonedTimeToUtc(2026, 9, 30, 9, 'Asia/Kolkata')).toBe(utc(2026, 9, 30, 3, 30));
  });

  it('knows whether an instant is inside the window', () => {
    expect(isInSendWindow(utc(2026, 9, 29, 20), NY)).toBe(true); // Tue 4:00 PM
    expect(isInSendWindow(utc(2026, 9, 29, 22, 30), NY)).toBe(false); // Tue 6:30 PM
    expect(isInSendWindow(utc(2026, 9, 29, 12, 59), NY)).toBe(false); // 8:59 AM
    expect(isInSendWindow(utc(2026, 9, 29, 13), NY)).toBe(true); // 9:00 AM
    expect(isInSendWindow(utc(2026, 9, 29, 21), NY)).toBe(false); // 5:00 PM is exclusive
    expect(isInSendWindow(utc(2026, 10, 3, 16), NY)).toBe(false); // Saturday
    expect(isInSendWindow(utc(2026, 10, 3, 5), IST)).toBe(true); // weekends allowed in IST window
  });

  it('rolls to the next opening: same day, next day, over a weekend, across DST', () => {
    expect(nextSendWindowStart(utc(2026, 9, 29, 20), NY)).toBe(utc(2026, 9, 29, 20)); // already inside
    expect(nextSendWindowStart(utc(2026, 9, 29, 10), NY)).toBe(utc(2026, 9, 29, 13)); // 6 AM → 9 AM today
    expect(nextSendWindowStart(utc(2026, 9, 29, 22, 30), NY)).toBe(utc(2026, 9, 30, 13)); // evening → tomorrow
    expect(nextSendWindowStart(utc(2026, 10, 2, 22, 30), NY)).toBe(utc(2026, 10, 5, 13)); // Fri evening → Mon
    expect(nextSendWindowStart(utc(2026, 10, 31, 16), NY)).toBe(utc(2026, 11, 2, 14)); // Sat → Mon, after DST ended
  });

  it('lists the open intervals inside a span', () => {
    const day = sendWindowIntervals(utc(2026, 9, 29, 0), utc(2026, 9, 30, 0), NY);
    expect(day).toEqual([[utc(2026, 9, 29, 13), utc(2026, 9, 29, 21)]]);
    expect(sendWindowIntervals(utc(2026, 9, 29, 12), utc(2026, 9, 29, 14), NY)).toEqual([[utc(2026, 9, 29, 13), utc(2026, 9, 29, 14)]]);
    expect(sendWindowIntervals(utc(2026, 10, 3, 0), utc(2026, 10, 4, 0), NY)).toEqual([]); // weekend
  });

  it('validates the schema (zone names, hour order)', () => {
    expect(SendWindowSchema.safeParse({ ...NY, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(SendWindowSchema.safeParse({ ...NY, startHour: 17, endHour: 9 }).success).toBe(false);
    expect(SendWindowSchema.safeParse({ startHour: 9, endHour: 24, timezone: 'UTC' }).success).toBe(true);
  });
});

describe('scheduleTimes', () => {
  it('spaces emails by the delay when no window is set', () => {
    expect(scheduleTimes(3, 1000, 500)).toEqual([1000, 1500, 2000]);
  });

  it('rolls emails that fall outside business hours to the next opening and keeps spacing from there', () => {
    // Tue 4:30 PM EDT start, one every 30 minutes, window 9–5.
    const t = scheduleTimes(5, utc(2026, 9, 29, 20, 30), 30 * 60_000, NY);
    expect(t).toEqual([
      utc(2026, 9, 29, 20, 30), // 4:30 PM ✓
      utc(2026, 9, 30, 13, 0), // 5:00 PM is closed → Wed 9:00 AM
      utc(2026, 9, 30, 13, 30),
      utc(2026, 9, 30, 14, 0),
      utc(2026, 9, 30, 14, 30),
    ]);
  });

  it('never schedules anything outside the window', () => {
    const t = scheduleTimes(200, utc(2026, 10, 2, 20), 15 * 60_000, NY);
    expect(t.every((x) => isInSendWindow(x, NY))).toBe(true);
    expect(t).toEqual([...t].sort((a, b) => a - b));
  });
});

describe('forecast', () => {
  const base = {
    windowMs: HOUR,
    minDelayMs: 2000,
    campaignLimit: 10_000,
    globalLimit: 200,
    senders: [50, 50, 50].map((limit) => ({ limit, used: 0 })),
  };
  const at = utc(2026, 9, 29, 10, 0);

  it('1,000 emails due at once: 150/hour (3 senders × 50), the rest carried in order', () => {
    const f = forecast({ ...base, nowMs: at, times: scheduleTimes(1000, at, 0) });
    expect(f.windows.map((w) => w.count)).toEqual([150, 150, 150, 150, 150, 150, 100]);
    expect(f.windows.slice(0, 6).every((w) => w.limited && w.carried > 0)).toBe(true);
    expect(f.windows.at(-1)?.carried).toBe(0);
    expect(f.windowsTotal).toBe(7);
    // finishes inside the 7th hour after the start
    const finish = new Date(f.finishAt!).getTime();
    expect(finish).toBeGreaterThanOrEqual(at + 6 * HOUR);
    expect(finish).toBeLessThan(at + 7 * HOUR);
  });

  it('is capped by the tightest of campaign / global / sender limits', () => {
    const f = forecast({ ...base, campaignLimit: 40, nowMs: at, times: scheduleTimes(100, at, 0) });
    expect(f.windows.map((w) => w.count)).toEqual([40, 40, 20]);
    const g = forecast({ ...base, globalLimit: 60, nowMs: at, times: scheduleTimes(100, at, 0) });
    expect(g.windows.map((w) => w.count)).toEqual([60, 40]);
  });

  it('accounts for quota the senders already used in the current window', () => {
    const f = forecast({
      ...base,
      senders: [50, 50, 50].map((limit) => ({ limit, used: 40 })),
      nowMs: at,
      times: scheduleTimes(100, at, 0),
    });
    expect(f.windows[0]!.count).toBe(30); // 150 − 120 used
  });

  it('a slow campaign (long delay) is never limited', () => {
    const f = forecast({ ...base, nowMs: at, times: scheduleTimes(10, at, 5 * 60_000) });
    expect(f.windows.every((w) => !w.limited)).toBe(true);
    expect(new Date(f.finishAt!).getTime()).toBe(at + 9 * 5 * 60_000);
  });

  it('with business hours, windows only exist inside open hours and weekends are skipped', () => {
    // Friday 4 PM EDT start, 500 emails at once, 150/hour → needs ~4 hours of opening time.
    const start = utc(2026, 10, 2, 20);
    const times = scheduleTimes(500, start, 0, NY);
    const f = forecast({ ...base, nowMs: start, times, sendWindow: NY });
    for (const w of f.windows) expect(isInSendWindow(new Date(w.start).getTime() + 1, NY)).toBe(true);
    // Fri 4–5 PM (150), then Monday 9–12 (150 + 150 + 50)
    expect(f.windows.map((w) => w.count)).toEqual([150, 150, 150, 50]);
    expect(new Date(f.windows[1]!.start).getTime()).toBe(utc(2026, 10, 5, 13));
    expect(new Date(f.finishAt!).getTime()).toBeGreaterThan(utc(2026, 10, 5, 15));
    expect(new Date(f.finishAt!).getTime()).toBeLessThan(utc(2026, 10, 5, 17));
  });

  it('handles empty input and reports when a run is too long to simulate', () => {
    expect(forecast({ ...base, nowMs: at, times: [] }).finishAt).toBeNull();
    const f = forecast({ ...base, nowMs: at, times: scheduleTimes(1000, at, 0), maxWindows: 3 });
    expect(f.finishAt).toBeNull();
    expect(f.truncated).toBe(true);
  });
});
