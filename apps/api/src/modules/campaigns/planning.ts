import type { PrismaClient } from '@prisma/client';
import { hash32, nextSendWindowStart, seededRandom, sendWindowIntervals, type ForecastWindow, type SendWindow } from '@ri/shared';

/**
 * When each email of a campaign is first scheduled: `start + i × delay`, and when a business-hours
 * window is set, anything that would land outside it rolls to the next opening (and the spacing
 * continues from there). Used by the real scheduler AND the compose-time forecast, so the preview
 * always matches what actually gets queued.
 */
export function scheduleTimes(
  count: number,
  startMs: number,
  delayMs: number,
  window?: SendWindow | null,
  /** Vary each gap by up to ±N% (0–50) so the cadence looks human. Deterministic from `seed`. */
  jitterPercent = 0,
  seed = '',
): number[] {
  const out: number[] = new Array<number>(count);
  const rnd = jitterPercent > 0 && delayMs > 0 ? seededRandom(`jitter:${seed}`) : null;
  const spread = Math.min(50, Math.max(0, jitterPercent)) / 100;
  let t = startMs;
  for (let i = 0; i < count; i++) {
    if (window) t = nextSendWindowStart(t, window);
    out[i] = t;
    // Mean gap stays `delayMs`; each gap lands in [delay × (1 − j), delay × (1 + j)]. The per-sender
    // minimum delay is enforced separately by the rate limiter, so jitter can never undercut it.
    t += rnd ? Math.round(delayMs * (1 + spread * (2 * rnd() - 1))) : delayMs;
  }
  return out;
}

/** Seed for a campaign's jitter: stable for the same lead list, so the forecast matches the real schedule. */
export const jitterSeed = (emails: string[]) => `${emails.length}:${hash32(emails.join(','))}`;

export type ForecastInput = {
  /** First-scheduled time of every email (from `scheduleTimes`). */
  times: number[];
  nowMs: number;
  windowMs: number;
  minDelayMs: number;
  campaignLimit: number;
  globalLimit: number;
  /** Active senders with their per-window limit and what they've already used in the current window. */
  senders: { limit: number; used: number }[];
  sendWindow?: SendWindow | null;
  /** How many windows we're willing to simulate before giving up. */
  maxWindows?: number;
  /** How many windows to return for display. */
  listWindows?: number;
};

export type Forecast = {
  firstSendAt: string | null;
  finishAt: string | null;
  windows: ForecastWindow[];
  windowsTotal: number;
  truncated: boolean;
};

/**
 * Simulates the rate limiter window by window: emails arrive at their scheduled times, each window
 * sends up to min(campaign, global, senders' capacity, what the min-delay spacing allows inside the
 * open hours), and whatever doesn't fit is carried — in order — to the next window. Approximate on
 * purpose ("≈ finishes …"), but built from the same numbers the real limiter uses.
 */
export function forecast(inp: ForecastInput): Forecast {
  const { times, windowMs, nowMs } = inp;
  if (times.length === 0) return { firstSendAt: null, finishAt: null, windows: [], windowsTotal: 0, truncated: false };

  const maxWindows = inp.maxWindows ?? 5000;
  const listMax = inp.listWindows ?? 48;
  const nSenders = Math.max(1, inp.senders.length);
  const senderCap = inp.senders.reduce((s, x) => s + x.limit, 0);
  const senderUsed = inp.senders.reduce((s, x) => s + x.used, 0);
  const spacing = Math.max(1, inp.minDelayMs / nSenders); // fastest pace the senders allow together
  const currentWindow = Math.floor(nowMs / windowMs);

  // Bucket arrivals per window index.
  const arrivals = new Map<number, number>();
  const lastArrival = new Map<number, number>();
  for (const t of times) {
    const w = Math.floor(t / windowMs);
    arrivals.set(w, (arrivals.get(w) ?? 0) + 1);
    lastArrival.set(w, Math.max(lastArrival.get(w) ?? 0, t));
  }
  const firstIdx = Math.floor(times[0]! / windowMs);
  const lastArrivalIdx = Math.floor(times[times.length - 1]! / windowMs);

  const windows: ForecastWindow[] = [];
  let carried = 0;
  let remaining = times.length;
  let finishAt: number | null = null;
  let windowsTotal = 0;
  let w = firstIdx;

  for (let guard = 0; remaining > 0 && guard < maxWindows; guard++, w++) {
    const ws = w * windowMs;
    const we = ws + windowMs;
    const incoming = arrivals.get(w) ?? 0;
    const waiting = carried + incoming;
    if (waiting === 0) {
      if (w > lastArrivalIdx) break;
      continue;
    }

    // Time inside this window that sending is allowed (business hours can shrink or zero it).
    const intervals = inp.sendWindow ? sendWindowIntervals(ws, we, inp.sendWindow) : ([[ws, we]] as [number, number][]);
    const openMs = intervals.reduce((s, [a, b]) => s + (b - a), 0);
    const firstOpen = intervals[0]?.[0] ?? ws;

    const used = w === currentWindow ? senderUsed : 0;
    const byLimits = Math.max(0, Math.min(inp.campaignLimit, inp.globalLimit - used, senderCap - used));
    const bySpacing = openMs > 0 ? Math.floor((openMs - 1) / spacing) + 1 : 0;
    const capacity = Math.min(byLimits, bySpacing);
    const sent = Math.min(waiting, capacity);

    const carryIn = carried;
    carried = waiting - sent;
    remaining -= sent;
    if (sent > 0) {
      windowsTotal++; // windows where something actually goes out (nights/weekends don't count)
      if (windows.length < listMax) {
        windows.push({
          start: new Date(ws).toISOString(),
          end: new Date(we).toISOString(),
          count: sent,
          carried,
          limited: carried > 0 && byLimits <= bySpacing,
        });
      }
    }
    if (sent > 0 && remaining === 0) {
      const natural = lastArrival.get(w);
      const paced = firstOpen + (sent - 1) * spacing;
      // Emails that arrive on their own schedule finish at their last arrival; carried-over ones
      // are paced by the senders' minimum delay from the moment the window opens.
      finishAt = Math.min(we - 1, carryIn === 0 && natural !== undefined ? Math.max(natural, paced) : paced);
    }
  }

  const finished = remaining === 0;
  return {
    firstSendAt: new Date(times[0]!).toISOString(),
    finishAt: finished && finishAt !== null ? new Date(finishAt).toISOString() : null,
    windows,
    windowsTotal,
    truncated: !finished || windowsTotal > listMax,
  };
}

/**
 * Compose-time and create-time guards: who must not be emailed?
 *  - suppressed: on the user's do-not-contact list
 *  - recentlyEmailed: already emailed/scheduled by this user within `skipRecentDays`
 */
export async function applyGuards<T extends { email: string }>(
  prisma: PrismaClient,
  userId: string,
  leads: T[],
  skipRecentDays: number,
): Promise<{ sendable: T[]; suppressed: string[]; recentlyEmailed: string[] }> {
  const emails = leads.map((l) => l.email);
  const suppressed = new Set<string>();
  const recent = new Set<string>();
  const since = new Date(Date.now() - skipRecentDays * 86_400_000);

  for (let i = 0; i < emails.length; i += 1000) {
    const chunk = emails.slice(i, i + 1000);
    const [blocked, seen] = await Promise.all([
      prisma.suppressedEmail.findMany({ where: { userId, email: { in: chunk } }, select: { email: true } }),
      skipRecentDays > 0
        ? prisma.email.findMany({
            where: {
              userId,
              toEmail: { in: chunk },
              // A failed or cancelled email never reached them, so it doesn't count as "already emailed".
              status: { in: ['SCHEDULED', 'RATE_LIMITED', 'SENDING', 'SENT'] },
              scheduledAt: { gte: since },
            },
            select: { toEmail: true },
            distinct: ['toEmail'],
          })
        : Promise.resolve([] as { toEmail: string }[]),
    ]);
    for (const b of blocked) suppressed.add(b.email);
    for (const s of seen) recent.add(s.toEmail);
  }

  const sendable: T[] = [];
  const suppressedList: string[] = [];
  const recentList: string[] = [];
  for (const l of leads) {
    if (suppressed.has(l.email)) suppressedList.push(l.email);
    else if (recent.has(l.email)) recentList.push(l.email);
    else sendable.push(l);
  }
  return { sendable, suppressed: suppressedList, recentlyEmailed: recentList };
}
