import { z } from 'zod';

/**
 * "Only send during business hours" (whole hours, in an IANA time zone, optionally weekdays only).
 * Pure functions on epoch milliseconds so the API (scheduling, worker) and the web app (preview)
 * agree exactly. No dependencies: everything goes through Intl.
 */

export const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const SendWindowSchema = z
  .object({
    /** Local hour the window opens, 0–23. */
    startHour: z.number().int().min(0).max(23),
    /** Local hour the window closes (exclusive), 1–24. */
    endHour: z.number().int().min(1).max(24),
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, 'Unknown time zone'),
    weekdaysOnly: z.boolean().default(true),
  })
  .refine((w) => w.endHour > w.startHour, { message: 'End hour must be after the start hour', path: ['endHour'] });
export type SendWindow = z.infer<typeof SendWindowSchema>;

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms: number, timeZone: string): Parts {
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday ?? 'Sun'] ?? 0,
  };
}

/** Offset (local − UTC) in ms at an instant. */
function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads y-m-d h:00 (day/hour may overflow). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  // Two passes handle offsets that change between the guess and the answer (DST).
  return guess - offsetMs(guess - offsetMs(guess, timeZone), timeZone);
}

const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const dayAllowed = (w: SendWindow, weekday: number) => !w.weekdaysOnly || (weekday !== 0 && weekday !== 6);

export function isInSendWindow(ms: number, w: SendWindow): boolean {
  const p = zonedParts(ms, w.timezone);
  return dayAllowed(w, p.weekday) && p.hour >= w.startHour && p.hour < w.endHour;
}

/** `ms` itself if it is inside the window, otherwise the next moment the window opens. */
export function nextSendWindowStart(ms: number, w: SendWindow): number {
  if (isInSendWindow(ms, w)) return ms;
  const p = zonedParts(ms, w.timezone);
  for (let k = 0; k <= 10; k++) {
    const open = zonedTimeToUtc(p.year, p.month, p.day + k, w.startHour, w.timezone);
    if (open < ms) continue;
    const day = zonedParts(open, w.timezone);
    if (dayAllowed(w, day.weekday)) return open;
  }
  return ms; // unreachable for sane windows; never block sending on a bug
}

/** The open intervals of the window that intersect [fromMs, toMs), clipped to it. */
export function sendWindowIntervals(fromMs: number, toMs: number, w: SendWindow): [number, number][] {
  const out: [number, number][] = [];
  const first = zonedParts(fromMs, w.timezone);
  const days = Math.min(400, Math.ceil((toMs - fromMs) / 86_400_000) + 3);
  for (let k = -1; k <= days; k++) {
    const y = first.year;
    const m = first.month;
    const d = first.day + k;
    const wd = weekdayOf(y, m, d);
    if (!dayAllowed(w, wd)) continue;
    const open = zonedTimeToUtc(y, m, d, w.startHour, w.timezone);
    const close = zonedTimeToUtc(y, m, d, w.endHour, w.timezone);
    const a = Math.max(open, fromMs);
    const b = Math.min(close, toMs);
    if (b > a) out.push([a, b]);
    if (open >= toMs) break;
  }
  return out;
}
