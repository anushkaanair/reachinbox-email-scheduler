import { afterAll, describe, expect, it } from 'vitest';
import { createRedis } from '../src/lib/redis.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { windowEnd, windowIndex } from '../src/throttle/windows.js';
import { testPrefix } from './helpers.js';

const redis = createRedis('test-throttle');
afterAll(() => redis.quit());

const HOUR = 3_600_000;
const BIG = { global: 1e6, sender: 1e6, campaign: 1e6 };
const limiter = (minDelayMs: number, windowMs = HOUR) =>
  new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs, minDelayMs });
// Anchor "now" at the start of a window so slot arithmetic never straddles a boundary.
const T0 = windowIndex(Date.now(), HOUR) * HOUR + HOUR * 10;

describe('windows', () => {
  it('aligns to fixed epoch windows', () => {
    const w = windowIndex(T0 + 1234, HOUR);
    expect(windowEnd(w, HOUR) - (T0 + 1234)).toBe(HOUR - 1234);
  });
});

describe('RateLimiter', () => {
  it('spaces sends from one sender by at least minDelay', async () => {
    const rl = limiter(2000);
    const slots: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await rl.acquire({ now: T0, senderId: 's1', campaignId: 'c1', limits: BIG });
      if (!r.ok) throw new Error('unexpected block');
      slots.push(r.ticket.slot);
    }
    expect(slots).toEqual([T0, T0 + 2000, T0 + 4000, T0 + 6000, T0 + 8000]);
  });

  it('keeps senders independent', async () => {
    const rl = limiter(2000);
    const a = await rl.acquire({ now: T0, senderId: 'a', campaignId: 'c', limits: BIG });
    const b = await rl.acquire({ now: T0, senderId: 'b', campaignId: 'c', limits: BIG });
    expect(a.ok && b.ok && a.ticket.slot === b.ticket.slot).toBe(true);
  });

  it('is atomic under concurrency: 50 parallel acquires get 50 distinct, evenly spaced slots', async () => {
    const rl = limiter(100);
    const res = await Promise.all(
      Array.from({ length: 50 }, () => rl.acquire({ now: T0, senderId: 's', campaignId: 'c', limits: BIG })),
    );
    const slots = res.map((r) => (r.ok ? r.ticket.slot : -1)).sort((x, y) => x - y);
    expect(new Set(slots).size).toBe(50);
    slots.forEach((s, i) => expect(s).toBe(T0 + i * 100));
  });

  it('blocks at the per-sender limit and reschedules into the next window, in FIFO order', async () => {
    const rl = limiter(10);
    const limits = { ...BIG, sender: 3 };
    const res = [];
    for (let i = 0; i < 6; i++) res.push(await rl.acquire({ now: T0, senderId: 's', campaignId: 'c', limits }));
    expect(res.slice(0, 3).every((r) => r.ok)).toBe(true);
    const blocked = res.slice(3);
    const next = windowEnd(windowIndex(T0, HOUR), HOUR);
    expect(blocked.map((r) => (!r.ok ? [r.scope, r.retryAt] : null))).toEqual([
      ['sender', next],
      ['sender', next + 10],
      ['sender', next + 20],
    ]);
  });

  it('enforces the global limit across different senders', async () => {
    const rl = limiter(0);
    const limits = { ...BIG, global: 2 };
    const r1 = await rl.acquire({ now: T0, senderId: 'x', campaignId: 'c', limits });
    const r2 = await rl.acquire({ now: T0, senderId: 'y', campaignId: 'c', limits });
    const r3 = await rl.acquire({ now: T0, senderId: 'z', campaignId: 'c', limits });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, false]);
    expect(!r3.ok && r3.scope).toBe('global');
  });

  it('is all-or-none: a campaign block consumes neither sender quota nor a slot', async () => {
    const rl = limiter(1000);
    const limits = { ...BIG, campaign: 1 };
    const ok = await rl.acquire({ now: T0, senderId: 's', campaignId: 'c', limits });
    const blocked = await rl.acquire({ now: T0, senderId: 's', campaignId: 'c', limits });
    expect(ok.ok).toBe(true);
    expect(!blocked.ok && blocked.scope).toBe('campaign');
    expect(await rl.senderUsage('s', T0)).toBe(1);
    // The next campaign's email from the same sender gets the very next slot (none was burned).
    const other = await rl.acquire({ now: T0, senderId: 's', campaignId: 'c2', limits });
    expect(other.ok && other.ticket.slot).toBe(T0 + 1000);
  });

  it('refunds a reserved send', async () => {
    const rl = limiter(0);
    const r = await rl.acquire({ now: T0, senderId: 's', campaignId: 'c', limits: BIG });
    if (!r.ok) throw new Error('unexpected block');
    expect(await rl.senderUsage('s', T0)).toBe(1);
    await rl.refund(r.ticket, 's', 'c');
    await rl.refund(r.ticket, 's', 'c'); // double refund never goes negative
    expect(await rl.senderUsage('s', T0)).toBe(0);
  });

  it('dispatch gate: never lets two dispatches of one sender closer than minDelay', async () => {
    const rl = limiter(2000);
    expect(await rl.gate('s', T0)).toBe(0);
    expect(await rl.gate('s', T0 + 1999)).toBe(T0 + 2000); // 1ms too early → told when
    expect(await rl.gate('other', T0 + 1)).toBe(0); // other senders unaffected
    expect(await rl.gate('s', T0 + 2000)).toBe(0);
    const racers = await Promise.all(Array.from({ length: 10 }, () => rl.gate('s', T0 + 4500)));
    expect(racers.filter((r) => r === 0)).toHaveLength(1); // exactly one winner under concurrency
  });

  it('reports the first limit hit per scope+window exactly once', async () => {
    const rl = limiter(0);
    expect(await rl.firstHitInWindow('sender', 's', 1)).toBe(true);
    expect(await rl.firstHitInWindow('sender', 's', 1)).toBe(false);
    expect(await rl.firstHitInWindow('sender', 's', 2)).toBe(true);
  });
});
