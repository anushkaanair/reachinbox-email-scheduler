import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isAuthError, isHardBounce, senderHealth, warmupCap, warmupDay, warmupPlan, SenderDetailSchema } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import type { SendFn } from '../src/mail/transport.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { createEmailProcessor, type SenderPausedNotice } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('warm-up maths', () => {
  const w = { start: 5, increment: 5, target: 50 };
  it('counts days from the start and ramps the cap until the target', () => {
    const t0 = Date.UTC(2026, 9, 1, 12);
    expect(warmupDay(t0, t0, DAY)).toBe(1);
    expect(warmupDay(t0, t0 + DAY, DAY)).toBe(2);
    expect(warmupDay(t0, t0 + 3 * DAY + HOUR, DAY)).toBe(4);
    expect([1, 2, 3, 9].map((d) => warmupCap(w, d))).toEqual([5, 10, 15, 45]);
    expect(warmupCap(w, 10)).toBeNull(); // 50 reached → complete, cap lifts
    expect(warmupPlan(w).map((p) => p.cap)).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(warmupPlan({ start: 10, increment: 7, target: 30 }).map((p) => p.cap)).toEqual([10, 17, 24, 30]);
  });
});

describe('health scoring', () => {
  const base = { sent: 0, failed: 0, deferred: 0, hardBounces: 0, consecutiveFailures: 0, paused: false, authError: false };
  it('a clean sender is healthy; no sends yet is neutral-good', () => {
    expect(senderHealth({ ...base, sent: 200 })).toMatchObject({ score: 100, status: 'healthy' });
    expect(senderHealth(base)).toMatchObject({ status: 'healthy', reasons: ['No recent sends yet.'] });
  });
  it('failures, bounces and streaks lower the score with reasons', () => {
    const r = senderHealth({ ...base, sent: 70, failed: 30, hardBounces: 10, consecutiveFailures: 4 });
    expect(r.status).toBe('at_risk');
    expect(r.reasons.join(' ')).toMatch(/30% of recent sends failed.*bounced.*last 4 sends in a row/);
  });
  it('little evidence means small deductions', () => {
    expect(senderHealth({ ...base, sent: 1, failed: 1 }).score).toBeGreaterThan(90);
  });
  it('a login error or a pause dominates', () => {
    expect(senderHealth({ ...base, sent: 50, authError: true }).status).toBe('at_risk');
    expect(senderHealth({ ...base, sent: 50, paused: true }).status).toBe('paused');
  });
  it('classifies SMTP errors', () => {
    expect(isAuthError('535 5.7.8 Authentication failed')).toBe(true);
    expect(isAuthError('Invalid login: 535')).toBe(true);
    expect(isAuthError('421 try again later')).toBe(false);
    expect(isHardBounce('550 5.1.1 User unknown')).toBe(true);
    expect(isHardBounce('553 mailbox not found')).toBe(true);
    expect(isHardBounce('421 4.7.0 Try again later')).toBe(false);
    expect(isHardBounce('ECONNRESET')).toBe(false);
  });
});

describe('daily cap in the atomic limiter', () => {
  const rl = new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: HOUR, minDelayMs: 0, dayMs: DAY });
  const T0 = Math.floor(Date.now() / DAY) * DAY + 10 * DAY + HOUR;
  const big = { global: 1e6, sender: 1e6, campaign: 1e6 };

  it('stops at the daily cap even with hourly room, and retries at the next day in order', async () => {
    const res = [];
    for (let i = 0; i < 5; i++) res.push(await rl.acquire({ now: T0, senderId: 'w', campaignId: 'c', limits: { ...big, daily: 3 } }));
    expect(res.slice(0, 3).every((r) => r.ok)).toBe(true);
    const next = (Math.floor(T0 / DAY) + 1) * DAY;
    expect(res.slice(3).map((r) => (!r.ok ? [r.scope, r.retryAt] : null))).toEqual([['daily', next], ['daily', next]]);
    expect(await rl.senderDailyUsage('w', T0)).toBe(3);
    expect(rl.windowStartFor('daily', Math.floor(T0 / DAY))).toBe(Math.floor(T0 / DAY) * DAY);
  });

  it('refund gives the day back; no cap means unlimited', async () => {
    const r = await rl.acquire({ now: T0, senderId: 'w2', campaignId: 'c', limits: { ...big, daily: 1 } });
    if (!r.ok) throw new Error('blocked');
    await rl.refund(r.ticket, 'w2', 'c');
    expect(await rl.senderDailyUsage('w2', T0)).toBe(0);
    for (let i = 0; i < 20; i++) expect((await rl.acquire({ now: T0, senderId: 'w3', campaignId: 'c', limits: big })).ok).toBe(true);
  });

  it('an hourly block does not consume the daily count', async () => {
    const lim = { global: 1e6, sender: 1, campaign: 1e6, daily: 10 };
    await rl.acquire({ now: T0, senderId: 'w4', campaignId: 'c', limits: lim });
    expect((await rl.acquire({ now: T0, senderId: 'w4', campaignId: 'c', limits: lim })).ok).toBe(false);
    expect(await rl.senderDailyUsage('w4', T0)).toBe(1);
  });
});

describe('worker: warm-up, circuit breaker and bounces', () => {
  const conn = createRedis('test-senders');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  let userId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: DAY };

  beforeAll(async () => {
    userId = (await makeUser('senders')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });

  const cookie = () => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
    return h;
  };
  async function sender(data: object = {}) {
    const s = await makeSender();
    senderIds.push(s.id);
    return Object.keys(data).length ? prisma.sender.update({ where: { id: s.id }, data }) : s;
  }
  async function emails(senderId: string, n: number) {
    const c = await createCampaign(
      userId,
      { subject: 's', body: 'b', leads: Array.from({ length: n }, (_, i) => ({ email: `w${i}-${randomUUID().slice(0, 6)}@x.dev` })), startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 1000, senderIds: [senderId] },
      { prisma, queues, config: cfg },
    );
    return prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } });
  }
  const job = (emailId: string, attempts = 3, attemptsMade = 0) => {
    const j = { id: emailId, data: { emailId } as EmailJobData, opts: { attempts }, attemptsMade, updateData: vi.fn(async (d: EmailJobData) => void (j.data = d)), moveToDelayed: vi.fn(async (_until: number, _token?: string) => {}), discard: vi.fn() };
    return j as unknown as Job<EmailJobData> & typeof j;
  };
  const processor = (send: SendFn, onSenderPaused = vi.fn(async (_n: SenderPausedNotice) => {})) => ({
    run: createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: HOUR, minDelayMs: 0, dayMs: DAY }),
      send,
      logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000, pauseAfterFailures: 3, pauseMs: 30 * 60_000 },
      onRateLimited: async () => {},
      onSenderPaused,
    }),
    onSenderPaused,
  });
  const ok: SendFn = async (_s, e) => ({ messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null });
  const failing = (msg: string): SendFn => async () => {
    throw new Error(msg);
  };

  it('a warming sender stops at today’s cap and the rest are deferred to the next day', async () => {
    const s = await sender({ warmupEnabled: true, warmupStartedAt: new Date(), warmupStart: 2, warmupIncrement: 2, warmupTarget: 20 });
    const rows = await emails(s.id, 4);
    const p = processor(ok);
    const out = [];
    for (const r of rows) out.push(await p.run(job(r.id), 't').catch((e: Error) => e.name));
    expect(out.slice(0, 2)).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
    const after = await prisma.email.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { sequence: 'asc' } });
    expect(after.map((r) => r.status)).toEqual(['SENT', 'SENT', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect(after[2]!.nextAttemptAt.getTime()).toBe((Math.floor(Date.now() / DAY) + 1) * DAY);
  });

  it('pauses a sender after 3 failures in a row, once, and its emails then wait without sending', async () => {
    const s = await sender();
    const rows = await emails(s.id, 5);
    const p = processor(failing('421 4.7.0 Temporary server error'));
    for (const r of rows.slice(0, 3)) await p.run(job(r.id), 't').catch(() => undefined);
    const paused = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(paused.consecutiveFailures).toBe(3);
    expect(paused.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(paused.pauseReason).toContain('3 sends in a row failed');
    expect(p.onSenderPaused).toHaveBeenCalledTimes(1);

    const send = vi.fn(ok);
    const j = job(rows[3]!.id);
    await expect(processor(send).run(j, 't')).rejects.toThrow(); // DelayedError
    expect(send).not.toHaveBeenCalled();
    expect(j.moveToDelayed.mock.calls[0]![0]).toBe(paused.pausedUntil!.getTime());

    // Resume (API) → sends again, and a success resets the streak.
    expect((await request(app).post(`/api/senders/${s.id}/resume`).set('Cookie', cookie())).status).toBe(204);
    expect(await processor(ok).run(job(rows[4]!.id), 't')).toEqual({ outcome: 'sent' });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).consecutiveFailures).toBe(0);
  });

  it('a login error pauses immediately', async () => {
    const s = await sender();
    const [r] = await emails(s.id, 1);
    const p = processor(failing('Invalid login: 535 Authentication failed'));
    await p.run(job(r!.id), 't').catch(() => undefined);
    const after = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.pausedUntil).not.toBeNull();
    expect(after.pauseReason).toContain('Login rejected');
    expect(p.onSenderPaused).toHaveBeenCalledTimes(1);
  });

  it('a hard bounce fails at once, is not retried, adds the address to do-not-contact, and does not count against the sender', async () => {
    const s = await sender();
    const [r] = await emails(s.id, 1);
    const j = job(r!.id, 3, 0);
    await expect(processor(failing('550 5.1.1 User unknown')).run(j, 't')).rejects.toThrow('550');
    expect(j.discard).toHaveBeenCalled();
    expect(await prisma.email.findUniqueOrThrow({ where: { id: r!.id } })).toMatchObject({ status: 'FAILED' });
    expect(await prisma.suppressedEmail.count({ where: { userId, email: r!.toEmail } })).toBe(1);
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).consecutiveFailures).toBe(0);
  });

  it('GET /api/senders/health reports health, warm-up day and today’s cap', async () => {
    const s = await sender({ warmupEnabled: true, warmupStartedAt: new Date(Date.now() - 2 * DAY), warmupStart: 5, warmupIncrement: 5, warmupTarget: 50 });
    const res = await request(app).get('/api/senders/health').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const mine = res.body.find((x: { id: string }) => x.id === s.id);
    expect(SenderDetailSchema.parse(mine).warmup).toMatchObject({ enabled: true, day: 3, capToday: 15, complete: false });
    expect(mine.warmup.plan).toHaveLength(10);
    expect(mine.dayLengthSeconds).toBeGreaterThan(0);
  });

  it('PUT warmup starts, updates and restarts the ramp; validates input; requires sign-in', async () => {
    const s = await sender();
    const put = (body: object) => request(app).put(`/api/senders/${s.id}/warmup`).set('Cookie', cookie()).send(body);
    expect((await put({ enabled: true, settings: { start: 10, increment: 10, target: 100 } })).status).toBe(204);
    const a = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(a).toMatchObject({ warmupEnabled: true, warmupStart: 10, warmupTarget: 100 });
    expect(a.warmupStartedAt).not.toBeNull();
    await put({ enabled: true, settings: { start: 10, increment: 5, target: 100 } });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).warmupStartedAt).toEqual(a.warmupStartedAt); // edit keeps the day count
    await new Promise((r) => setTimeout(r, 5));
    await put({ enabled: true, restart: true });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).warmupStartedAt!.getTime()).toBeGreaterThan(a.warmupStartedAt!.getTime());
    await put({ enabled: false });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).warmupEnabled).toBe(false);
    expect((await put({ enabled: true, settings: { start: 50, increment: 5, target: 10 } })).status).toBe(400);
    expect((await request(app).put(`/api/senders/${s.id}/warmup`).send({ enabled: true })).status).toBe(401);
    expect((await request(app).put(`/api/senders/nope/warmup`).set('Cookie', cookie()).send({ enabled: true })).status).toBe(404);
  });
});
