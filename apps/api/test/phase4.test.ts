import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@ri/shared';
import { createApp } from '../src/app.js';
import { publishLive } from '../src/lib/live.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { createEmailProcessor } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const conn = createRedis('test-p4');
const queues = createQueues(conn, testPrefix());
const app = createApp({ queues });
const DAY = 86_400_000;
const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: DAY };

let userId: string;
let otherId: string;
let senderId: string;

const cookieFor = (id: string) => {
  let h = '';
  setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
  return h;
};
const cookie = () => cookieFor(userId);

async function campaign(n: number, startInMs = DAY) {
  const res = await createCampaign(
    userId,
    {
      subject: 'S',
      body: 'B',
      leads: Array.from({ length: n }, (_, i) => ({ email: `p4-${i}-${Math.random()}@x.dev` })),
      startAt: new Date(Date.now() + startInMs).toISOString(),
      delayBetweenSeconds: 0,
      hourlyLimit: 1000,
      senderIds: [senderId],
    },
    { prisma, queues, config: cfg },
  );
  const rows = await prisma.email.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
  return { id: res.campaignId, rows };
}
const state = (id: string) => queues.email.getJobState(id);

beforeAll(async () => {
  userId = (await makeUser('p4')).id;
  otherId = (await makeUser('p4other')).id;
  senderId = (await makeSender()).id;
});

afterAll(async () => {
  await app.live.close();
  for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
  await closeQueues(queues);
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await prisma.sender.delete({ where: { id: senderId } });
  await conn.quit();
  await redis.quit();
  await prisma.$disconnect();
});

describe('campaign controls (F3)', () => {
  it('pause removes pending jobs; resume re-adds them with the same ids; history is recorded', async () => {
    const c = await campaign(3);
    expect(await state(c.rows[0]!.id)).toBe('delayed');

    expect((await request(app).post(`/api/campaigns/${c.id}/pause`).set('Cookie', cookie())).status).toBe(204);
    for (const r of c.rows) expect(await state(r.id)).toBe('unknown');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('PAUSED');
    // Pausing twice is a clear conflict, not a silent no-op.
    expect((await request(app).post(`/api/campaigns/${c.id}/pause`).set('Cookie', cookie())).status).toBe(409);

    expect((await request(app).post(`/api/campaigns/${c.id}/resume`).set('Cookie', cookie())).status).toBe(204);
    for (const r of c.rows) expect(await state(r.id)).toBe('delayed');
    const types = (await prisma.emailEvent.findMany({ where: { emailId: c.rows[0]!.id }, orderBy: { at: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(['SCHEDULED', 'PAUSED', 'RESUMED']);
  });

  it('a paused campaign never sends, even if a job fires', async () => {
    const c = await campaign(1, 0);
    await request(app).post(`/api/campaigns/${c.id}/pause`).set('Cookie', cookie());
    const send = vi.fn();
    const processor = createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: DAY, minDelayMs: 0 }),
      send,
      logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000 },
      onRateLimited: async () => {},
    });
    const job = { id: c.rows[0]!.id, data: { emailId: c.rows[0]!.id }, opts: {}, attemptsMade: 0 } as unknown as Job<EmailJobData>;
    expect(await processor(job, 't')).toEqual({ outcome: 'skipped', reason: 'campaign_paused' });
    expect(send).not.toHaveBeenCalled();
  });

  it('cancel marks pending emails CANCELLED and removes their jobs', async () => {
    const c = await campaign(2);
    expect((await request(app).post(`/api/campaigns/${c.id}/cancel`).set('Cookie', cookie())).status).toBe(204);
    const rows = await prisma.email.findMany({ where: { campaignId: c.id } });
    expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    for (const r of rows) expect(await state(r.id)).toBe('unknown');
  });

  it('another user cannot control my campaign', async () => {
    const c = await campaign(1);
    expect((await request(app).post(`/api/campaigns/${c.id}/pause`).set('Cookie', cookieFor(otherId))).status).toBe(404);
  });

  it('lists campaigns with per-status counts and derives COMPLETED', async () => {
    const c = await campaign(2);
    await prisma.email.updateMany({ where: { campaignId: c.id }, data: { status: 'SENT', sentAt: new Date() } });
    const res = await request(app).get('/api/campaigns').set('Cookie', cookie());
    const mine = res.body.find((x: { id: string }) => x.id === c.id);
    expect(mine).toMatchObject({ status: 'COMPLETED', total: 2, counts: { sent: 2, scheduled: 0 } });
  });
});

describe('per-email actions (F6 retry, cancel) and detail timeline (F5)', () => {
  it('retry: FAILED → SCHEDULED with a fresh job under the same id; only failed emails', async () => {
    const c = await campaign(1);
    const id = c.rows[0]!.id;
    expect((await request(app).post(`/api/emails/${id}/retry`).set('Cookie', cookie())).status).toBe(409);

    await prisma.email.update({ where: { id }, data: { status: 'FAILED', failedAt: new Date(), lastError: 'SMTP 550' } });
    await queues.email.remove(id);
    expect((await request(app).post(`/api/emails/${id}/retry`).set('Cookie', cookie())).status).toBe(204);
    const row = await prisma.email.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'SCHEDULED', lastError: null, failedAt: null });
    expect(await state(id)).toBe('waiting'); // due now

    const detail = await request(app).get(`/api/emails/${id}`).set('Cookie', cookie());
    expect(detail.body.events.map((e: { type: string }) => e.type)).toEqual(['SCHEDULED', 'RETRIED']);
    expect(detail.body.campaignStatus).toBe('ACTIVE');
  });

  it('cancel a single scheduled email', async () => {
    const c = await campaign(2);
    const id = c.rows[1]!.id;
    expect((await request(app).post(`/api/emails/${id}/cancel`).set('Cookie', cookie())).status).toBe(204);
    expect((await prisma.email.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    expect(await state(id)).toBe('unknown');
    expect(await state(c.rows[0]!.id)).toBe('delayed'); // sibling untouched
  });
});

describe('analytics (F4)', () => {
  it('returns zero-filled hourly series, totals and sender meters', async () => {
    const c = await campaign(3);
    await prisma.email.update({ where: { id: c.rows[0]!.id }, data: { status: 'SENT', sentAt: new Date() } });
    await prisma.email.update({ where: { id: c.rows[1]!.id }, data: { status: 'FAILED', failedAt: new Date() } });
    await prisma.emailEvent.create({ data: { emailId: c.rows[2]!.id, userId, type: 'RATE_LIMITED' } });

    const res = await request(app).get('/api/analytics?hours=6').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.body.hourly.length).toBeGreaterThanOrEqual(6);
    expect(res.body.totals.sent).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.failed).toBeGreaterThanOrEqual(1);
    expect(res.body.totals.rateLimited).toBeGreaterThanOrEqual(1);
    const last = res.body.hourly.at(-1);
    expect(last.sent + last.failed + last.rateLimited).toBeGreaterThanOrEqual(1);
    expect(res.body.senders.find((s: { id: string }) => s.id === senderId)).toMatchObject({ used: 0 });
  });
});

describe('live updates over SSE (F1)', () => {
  it('streams events published for the user, and only for that user', async () => {
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { Cookie: cookie() }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const received: LiveEvent[] = [];
    const pump = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (const line of buf.split('\n')) if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    })();

    await new Promise((r) => setTimeout(r, 300)); // let the subscription attach
    await publishLive(redis, otherId, { type: 'campaign.updated', campaignId: 'not-mine', status: 'PAUSED' });
    await publishLive(redis, userId, { type: 'email.updated', emailId: 'e1', campaignId: 'c1', status: 'SENT' });
    await new Promise((r) => setTimeout(r, 300));

    expect(received).toEqual([{ type: 'email.updated', emailId: 'e1', campaignId: 'c1', status: 'SENT' }]);
    ctrl.abort();
    await pump;
    await new Promise((r) => server.close(r));
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/events')).status).toBe(401);
  });
});
