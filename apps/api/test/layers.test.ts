import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hoursFor, isInSendWindow, nextSendWindowStart, SendWindowSchema, sendWindowIntervals, zonedParts, type SendWindow } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { forecast, scheduleTimes } from '../src/modules/campaigns/planning.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeSender, makeUser, testPrefix } from './helpers.js';

// 2026-09-28 is a Monday; 09-29 Tue; 09-30 Wed; 10-01 Thu; 10-02 Fri; 10-03 Sat; 10-04 Sun; 10-05 Mon.
const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const HOUR = 3_600_000;

/** Mon–Fri 9–17 UTC, but Friday closes at 1 PM and Saturday is open 10–12. */
const W: SendWindow = {
  startHour: 9,
  endHour: 17,
  timezone: 'UTC',
  weekdaysOnly: true,
  layers: [
    { days: [5], startHour: 9, endHour: 13 },
    { days: [6], startHour: 10, endHour: 12 },
  ],
};
const BASE: SendWindow = { ...W, layers: undefined };

describe('day-specific hours', () => {
  it('uses the layer on its days and the base window everywhere else', () => {
    expect(hoursFor(W, 1)).toEqual({ start: 9, end: 17 }); // Monday: base
    expect(hoursFor(W, 5)).toEqual({ start: 9, end: 13 }); // Friday: layer
    expect(hoursFor(W, 6)).toEqual({ start: 10, end: 12 }); // Saturday: the layer opens a day the base skips
    expect(hoursFor(W, 0)).toBeNull(); // Sunday: weekdays only, no layer
    expect(hoursFor(BASE, 6)).toBeNull();
    expect(hoursFor({ ...BASE, weekdaysOnly: false }, 0)).toEqual({ start: 9, end: 17 });
  });

  it('knows what is open', () => {
    expect(isInSendWindow(utc(2026, 10, 1, 14), W)).toBe(true); // Thu 14:00 (base)
    expect(isInSendWindow(utc(2026, 10, 2, 12, 59), W)).toBe(true); // Fri 12:59
    expect(isInSendWindow(utc(2026, 10, 2, 13), W)).toBe(false); // Fri 13:00 (closed early; exclusive)
    expect(isInSendWindow(utc(2026, 10, 2, 14), BASE)).toBe(true); // …but open without the layer
    expect(isInSendWindow(utc(2026, 10, 3, 11), W)).toBe(true); // Sat 11:00
    expect(isInSendWindow(utc(2026, 10, 3, 9), W)).toBe(false); // Sat 09:00 (opens at 10)
    expect(isInSendWindow(utc(2026, 10, 3, 12), W)).toBe(false);
    expect(isInSendWindow(utc(2026, 10, 4, 11), W)).toBe(false); // Sunday
  });

  it('finds the next opening, including days only a layer opens', () => {
    expect(nextSendWindowStart(utc(2026, 10, 2, 14), W)).toBe(utc(2026, 10, 3, 10)); // Fri after close → Sat morning
    expect(nextSendWindowStart(utc(2026, 10, 3, 12, 30), W)).toBe(utc(2026, 10, 5, 9)); // Sat after close → Monday
    expect(nextSendWindowStart(utc(2026, 10, 4, 12), W)).toBe(utc(2026, 10, 5, 9)); // Sunday → Monday
    expect(nextSendWindowStart(utc(2026, 10, 2, 8), W)).toBe(utc(2026, 10, 2, 9)); // Fri before open
    expect(nextSendWindowStart(utc(2026, 10, 2, 10), W)).toBe(utc(2026, 10, 2, 10)); // already open: unchanged
    expect(nextSendWindowStart(utc(2026, 10, 2, 14), BASE)).toBe(utc(2026, 10, 2, 14)); // without the layer Friday 14:00 is still open
    expect(nextSendWindowStart(utc(2026, 10, 2, 18), BASE)).toBe(utc(2026, 10, 5, 9)); // after 17:00 with no layers: straight to Monday
  });

  it('lists the open intervals per day', () => {
    const iv = sendWindowIntervals(utc(2026, 10, 1, 0), utc(2026, 10, 6, 0), W);
    expect(iv).toEqual([
      [utc(2026, 10, 1, 9), utc(2026, 10, 1, 17)], // Thu
      [utc(2026, 10, 2, 9), utc(2026, 10, 2, 13)], // Fri, closes early
      [utc(2026, 10, 3, 10), utc(2026, 10, 3, 12)], // Sat, layer
      [utc(2026, 10, 5, 9), utc(2026, 10, 5, 17)], // Mon (Sunday skipped)
    ]);
  });

  it('a layer can also shorten or move a weekday that the base allows', () => {
    const late: SendWindow = { ...BASE, layers: [{ days: [3], startHour: 12, endHour: 14 }] }; // Wednesday only 12–14
    expect(isInSendWindow(utc(2026, 9, 30, 10), late)).toBe(false);
    expect(isInSendWindow(utc(2026, 9, 30, 13), late)).toBe(true);
    expect(isInSendWindow(utc(2026, 9, 29, 10), late)).toBe(true); // Tuesday unaffected
  });

  it('works in a real time zone, with the layer hours read in local time', () => {
    const ny: SendWindow = { ...W, timezone: 'America/New_York' }; // EDT = UTC-4 on these dates
    expect(isInSendWindow(utc(2026, 10, 2, 16, 59), ny)).toBe(true); // Fri 12:59 NY
    expect(isInSendWindow(utc(2026, 10, 2, 17), ny)).toBe(false); // Fri 13:00 NY
    expect(zonedParts(nextSendWindowStart(utc(2026, 10, 2, 18), ny), 'America/New_York')).toMatchObject({ weekday: 6, hour: 10 });
  });
});

describe('send window schema', () => {
  const ok = { startHour: 9, endHour: 17, timezone: 'UTC', weekdaysOnly: true };
  it('still accepts a window saved before layers existed', () => {
    const p = SendWindowSchema.parse(ok);
    expect(p.layers).toBeUndefined();
    expect(isInSendWindow(utc(2026, 10, 2, 14), p)).toBe(true);
  });
  it('validates layers', () => {
    const layer = (days: number[], startHour = 9, endHour = 13) => ({ ...ok, layers: [{ days, startHour, endHour }] });
    expect(SendWindowSchema.safeParse(layer([5])).success).toBe(true);
    expect(SendWindowSchema.safeParse(layer([])).success).toBe(false); // no days
    expect(SendWindowSchema.safeParse(layer([7])).success).toBe(false); // not a weekday
    expect(SendWindowSchema.safeParse(layer([5], 13, 13)).success).toBe(false); // ends when it starts
    expect(SendWindowSchema.safeParse({ ...ok, layers: [{ days: [5], startHour: 9, endHour: 13 }, { days: [5, 6], startHour: 10, endHour: 12 }] }).success).toBe(false); // Friday twice
    expect(SendWindowSchema.safeParse({ ...ok, layers: Array.from({ length: 8 }, () => ({ days: [1], startHour: 9, endHour: 10 })) }).success).toBe(false);
  });
});

describe('scheduling and forecasting honour the layers', () => {
  it('spreads emails across Friday, Saturday and Monday, never outside the hours', () => {
    const start = utc(2026, 10, 2, 9); // Friday 09:00
    const times = scheduleTimes(12, start, HOUR, W, 0, 'seed');
    expect(times).toHaveLength(12);
    for (const t of times) expect(isInSendWindow(t, W), new Date(t).toISOString()).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const days = times.map((t) => zonedParts(t, 'UTC').weekday);
    expect(days.slice(0, 4)).toEqual([5, 5, 5, 5]); // Fri 9, 10, 11, 12 (closes at 13)
    expect(days.slice(4, 6)).toEqual([6, 6]); // Sat 10, 11
    expect(days[6]).toBe(1); // then Monday
    expect(times[4]).toBe(utc(2026, 10, 3, 10));
    expect(times[6]).toBe(utc(2026, 10, 5, 9));
  });

  it('the forecast finishes earlier when a Saturday layer is available', () => {
    const base = { times: Array.from({ length: 8 }, (_, i) => utc(2026, 10, 2, 9) + i * HOUR), nowMs: utc(2026, 10, 2, 8), windowMs: HOUR, minDelayMs: 0, campaignLimit: 1000, globalLimit: 1000, senders: [{ limit: 1000, used: 0 }] };
    const withLayer = forecast({ ...base, sendWindow: W });
    const without = forecast({ ...base, sendWindow: { ...BASE, layers: [{ days: [5], startHour: 9, endHour: 13 }] } });
    expect(new Date(withLayer.finishAt!).getTime()).toBeLessThan(new Date(without.finishAt!).getTime());
  });
});

describe('layers through the API', () => {
  const conn = createRedis('test-layers');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  let userId: string;
  let senderId: string;

  beforeAll(async () => {
    userId = (await makeUser('layers')).id;
    senderId = (await makeSender()).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.delete({ where: { id: senderId } });
    await conn.quit();
  });
  const cookie = () => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
    return h;
  };
  const leads = (n: number) => Array.from({ length: n }, () => ({ email: `l-${randomUUID().slice(0, 8)}@x.dev` }));
  const future = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(9, 0, 0, 0); return d.toISOString(); }; // tomorrow 09:00 UTC

  it('schedules only inside the layered hours', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({ subject: 'S', body: 'b', leads: leads(40), startAt: future(), delayBetweenSeconds: 1800, hourlyLimit: 1000, senderIds: [senderId], sendWindow: W });
    expect(res.status).toBe(201);
    const rows = await prisma.email.findMany({ where: { campaignId: res.body.campaignId }, orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(40);
    for (const r of rows) expect(isInSendWindow(r.scheduledAt.getTime(), W), r.scheduledAt.toISOString()).toBe(true);
    const days = new Set(rows.map((r) => zonedParts(r.scheduledAt.getTime(), 'UTC').weekday));
    expect(days.has(0)).toBe(false); // never Sunday
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: res.body.campaignId } });
    expect(SendWindowSchema.parse(camp.sendWindow).layers).toEqual(W.layers); // stored with its layers, so the worker enforces them too
  });

  it('rejects conflicting layers with a clear error', async () => {
    const bad = { ...W, layers: [{ days: [5], startHour: 9, endHour: 13 }, { days: [5], startHour: 10, endHour: 12 }] };
    const res = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({ subject: 'S', body: 'b', leads: leads(1), startAt: future(), delayBetweenSeconds: 1, hourlyLimit: 10, senderIds: [senderId], sendWindow: bad });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/only be in one set/);
  });

  it('the forecast endpoint accepts layers', async () => {
    const res = await request(app).post('/api/campaigns/preflight').set('Cookie', cookie()).send({ emails: leads(6).map((l) => l.email), startAt: future(), delayBetweenSeconds: 1800, hourlyLimit: 1000, sendWindow: W });
    expect(res.status).toBe(200);
    expect(res.body.forecast.finishAt).toBeTruthy();
  });
});
