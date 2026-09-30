import { isValidTimeZone, zonedParts, zonedTimeToUtc } from '@ri/shared';
import type { RangeSpec } from './intents.js';

export const nf = new Intl.NumberFormat('en-US');
export const plural = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;
export const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const shortId = (id: string) => id.slice(0, 8);
export const safeZone = (tz?: string) => (tz && isValidTimeZone(tz) ? tz : 'UTC');

const DAY = 86_400_000;

/** [since, until) for a range in the user's time zone; `undefined` bounds mean "no limit". */
export function rangeBounds(range: RangeSpec, tz: string, now = Date.now()): { since?: Date; until?: Date; label: string } {
  const p = zonedParts(now, tz);
  const startOfToday = zonedTimeToUtc(p.year, p.month, p.day, 0, tz);
  switch (range.kind) {
    case 'today':
      return { since: new Date(startOfToday), label: 'today' };
    case 'yesterday':
      return { since: new Date(zonedTimeToUtc(p.year, p.month, p.day - 1, 0, tz)), until: new Date(startOfToday), label: 'yesterday' };
    case 'tomorrow':
      return { since: new Date(zonedTimeToUtc(p.year, p.month, p.day + 1, 0, tz)), until: new Date(zonedTimeToUtc(p.year, p.month, p.day + 2, 0, tz)), label: 'tomorrow' };
    case 'hours':
      return { since: new Date(now - range.n * 3_600_000), label: range.n === 1 ? 'in the last hour' : `in the last ${range.n} hours` };
    case 'days':
      return { since: new Date(now - range.n * DAY), label: range.n === 7 ? 'in the last 7 days' : `in the last ${range.n} days` };
    default:
      return { label: 'in total' };
  }
}

const timeFmt = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
const dayFmt = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });

/** "Today 3:40 PM", "Tomorrow 9:00 AM", "Wed 30 Sep, 9:00 AM" — in the user's time zone. */
export function fmtWhen(ms: number | Date, tz: string, now = Date.now()): string {
  const t = typeof ms === 'number' ? ms : ms.getTime();
  const a = zonedParts(t, tz);
  const b = zonedParts(now, tz);
  const dayIndex = (x: typeof a) => Date.UTC(x.year, x.month - 1, x.day) / DAY;
  const diff = dayIndex(a) - dayIndex(b);
  const time = timeFmt(tz).format(new Date(t));
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  return `${dayFmt(tz).format(new Date(t))}, ${time}`;
}

/** "in 5 minutes", "2 hours ago" — coarse and honest. */
export function fmtRelative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit = abs < 90_000 ? [Math.max(1, Math.round(abs / 1000)), 'second'] : abs < 5_400_000 ? [Math.round(abs / 60_000), 'minute'] : abs < 129_600_000 ? [Math.round(abs / 3_600_000), 'hour'] : [Math.round(abs / DAY), 'day'];
  const label = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}
