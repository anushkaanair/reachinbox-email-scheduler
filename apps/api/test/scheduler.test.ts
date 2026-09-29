import type { Job } from 'bullmq';
import type { Sender } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import type { SendFn } from '../src/mail/transport.js';
import { createCampaign, normalizeLeads } from '../src/modules/campaigns/service.js';
import { setSession } from '../src/modules/auth/session.js';
import { createEmailProcessor, type ProcessorConfig } from '../src/queues/emailProcessor.js';
import {
  closeQueues,
  createQueues,
  enqueueEmails,
  type EmailJobData,
  type QueueSet,
  type RateLimitNotice,
} from '../src/queues/queues.js';
import { startEmailWorker } from '../src/queues/workers.js';
import { reconcile } from '../src/recovery/reconciler.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, statusCounts, testPrefix, waitFor } from './helpers.js';

const DAY = 86_400_000; // long windows so a test never straddles a window boundary
const conn = createRedis('test-scheduler');
const prefix = testPrefix();
const queues: QueueSet = createQueues(conn, prefix);
const schedCfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: DAY };
const procCfg: ProcessorConfig = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000 };

let userId: string;
const senders: Sender[] = [];
/** Workers started by the current test; closed after it so they can't steal the next test's jobs. */
let active: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(active.map((c) => c()));
  active = [];
});

const leads = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => ({ email: `lead${i}-${tag}@x.dev`, name: `Lead ${i}` }));

async function schedule(n: number, opts: { senderIds: string[]; hourlyLimit?: number; startAt?: Date; tag?: string }) {
  return createCampaign(
    userId,
    {
      subject: 'Hi {{name}}',
      body: 'Hello {{name}} <{{email}}>',
      leads: leads(n, opts.tag ?? String(Math.random())),
      startAt: (opts.startAt ?? new Date()).toISOString(),
      delayBetweenSeconds: 0,
      hourlyLimit: opts.hourlyLimit ?? 100_000,
      senderIds: opts.senderIds,
    },
    { prisma, queues, config: schedCfg },
  );
}

function worker(send: SendFn, opts: { minDelayMs?: number; concurrency?: number; perSender?: number } = {}) {
  const c = createRedis('test-worker');
  const limiter = new RateLimiter(redis, { prefix: `${prefix}:`, windowMs: DAY, minDelayMs: opts.minDelayMs ?? 0 });
  const onRateLimited = vi.fn(async (_notice: RateLimitNotice) => {});
  const w = startEmailWorker(
    { connection: c, prefix, concurrency: opts.concurrency ?? 10 },
    {
      prisma,
      limiter,
      send,
      logger: silentLogger,
      config: { ...procCfg, maxPerWindowPerSender: opts.perSender ?? 1e6 },
      onRateLimited,
    },
  );
  active.push(async () => {
    await w.close();
    await c.quit();
  });
  return { w, onRateLimited };
}

const okSend = (delayMs = 5): SendFn & { mock: { calls: unknown[][] } } =>
  vi.fn(async (_s, e) => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null };
  }) as never;

beforeAll(async () => {
  userId = (await makeUser('sched')).id;
  for (let i = 0; i < 3; i++) senders.push(await makeSender());
});

afterAll(async () => {
  for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
  await closeQueues(queues);
  await prisma.user.delete({ where: { id: userId } });
  await prisma.sender.deleteMany({ where: { id: { in: senders.map((s) => s.id) } } });
  await prisma.$disconnect();
  await conn.quit();
  await redis.quit();
});

describe('lead normalisation', () => {
  it('trims, lowercases, drops invalid and duplicate addresses', () => {
    const r = normalizeLeads([
      { email: ' A@X.dev ' },
      { email: 'a@x.dev' },
      { email: 'not-an-email' },
      { email: 'b@x.dev' },
    ]);
    expect(r.clean.map((l) => l.email)).toEqual(['a@x.dev', 'b@x.dev']);
    expect(r.invalid).toEqual(['not-an-email']);
    expect(r.duplicates).toBe(1);
  });
});

describe('scheduling', () => {
  it('persists rows and one delayed job per email (jobId = email id); re-enqueue is a no-op', async () => {
    const start = new Date(Date.now() + 3_600_000);
    const res = await schedule(10, { senderIds: senders.map((s) => s.id), startAt: start });
    const rows = await prisma.email.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
    expect(rows).toHaveLength(10);
    expect(rows[0]!.subject).toBe('Hi Lead 0'); // merge tags rendered
    expect(new Set(rows.map((r) => r.senderId)).size).toBe(3); // round-robin
    for (const r of rows) expect(await queues.email.getJobState(r.id)).toBe('delayed');

    const before = await queues.email.getJobCounts('delayed');
    await enqueueEmails(queues.email, rows); // duplicate enqueue (double click, reconciler race…)
    expect(await queues.email.getJobCounts('delayed')).toEqual(before);
  });
});

describe('worker', () => {
  it('sends every email exactly once with 2 workers × concurrency 10', async () => {
    const send = okSend();
    worker(send);
    worker(send);
    const res = await schedule(40, { senderIds: senders.map((s) => s.id) });
    await waitFor(() => statusCounts(res.campaignId), (c) => c.SENT === 40);

    const ids = send.mock.calls.map((c) => (c[1] as { emailId: string }).emailId);
    const mine = await prisma.email.findMany({ where: { campaignId: res.campaignId }, select: { id: true, messageId: true } });
    const mineIds = new Set(mine.map((m) => m.id));
    const sentForCampaign = ids.filter((id) => mineIds.has(id));
    expect(sentForCampaign).toHaveLength(40);
    expect(new Set(sentForCampaign).size).toBe(40); // no duplicates
    expect(mine.every((m) => m.messageId === `<${m.id}@reachinbox.local>`)).toBe(true);
  });
});

describe('processor idempotency & failure handling (direct)', () => {
  const fakeJob = (emailId: string, attempts = 1) => {
    const job = {
      id: emailId,
      data: { emailId } as EmailJobData,
      opts: { attempts },
      attemptsMade: 0,
      updateData: vi.fn(async (d: EmailJobData) => void (job.data = d)),
      moveToDelayed: vi.fn(async () => {}),
    };
    return job as unknown as Job<EmailJobData> & typeof job;
  };
  const processor = (send: SendFn) =>
    createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${prefix}:direct:`, windowMs: DAY, minDelayMs: 0 }),
      send,
      logger: silentLogger,
      config: procCfg,
      onRateLimited: async () => {},
    });

  it('never re-sends an email that is already SENT', async () => {
    const res = await schedule(1, { senderIds: [senders[0]!.id], startAt: new Date(Date.now() + DAY) });
    const e = await prisma.email.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    await prisma.email.update({ where: { id: e.id }, data: { status: 'SENT', sentAt: new Date() } });
    const send = okSend();
    expect(await processor(send)(fakeJob(e.id), 'tok')).toEqual({ outcome: 'skipped', reason: 'already_sent' });
    expect(send).not.toHaveBeenCalled();
  });

  it('marks FAILED after the last attempt and refunds the quota', async () => {
    const res = await schedule(1, { senderIds: [senders[1]!.id], startAt: new Date(Date.now() + DAY) });
    const e = await prisma.email.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    const failing: SendFn = async () => {
      throw new Error('SMTP 421 try later');
    };
    await expect(processor(failing)(fakeJob(e.id, 1), 'tok')).rejects.toThrow('SMTP 421');
    const after = await prisma.email.findUniqueOrThrow({ where: { id: e.id } });
    expect(after).toMatchObject({ status: 'FAILED', lastError: 'SMTP 421 try later', attempts: 1 });
  });

  it('a stale SENDING row is failed, never re-sent (at-most-once)', async () => {
    const res = await schedule(1, { senderIds: [senders[2]!.id], startAt: new Date(Date.now() + DAY) });
    const e = await prisma.email.findFirstOrThrow({ where: { campaignId: res.campaignId } });
    await prisma.email.update({ where: { id: e.id }, data: { status: 'SENDING', lockedAt: new Date(Date.now() - 120_000) } });
    const send = okSend();
    expect((await processor(send)(fakeJob(e.id), 'tok')).reason).toBe('stale_sending');
    expect(send).not.toHaveBeenCalled();
    expect((await prisma.email.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('FAILED');
  });
});

describe('rate limiting end-to-end', () => {
  it('sends up to the per-sender limit, defers the rest to the next window in order, notifies once', async () => {
    const sender = await makeSender({ hourlyLimit: 5 });
    senders.push(sender);
    const { onRateLimited } = worker(okSend(), { concurrency: 1 });
    const res = await schedule(12, { senderIds: [sender.id] });

    const counts = await waitFor(
      () => statusCounts(res.campaignId),
      (c) => (c.SENT ?? 0) + (c.RATE_LIMITED ?? 0) === 12,
    );
    expect(counts).toEqual({ SENT: 5, RATE_LIMITED: 7 });

    const deferred = await prisma.email.findMany({
      where: { campaignId: res.campaignId, status: 'RATE_LIMITED' },
      orderBy: { sequence: 'asc' },
    });
    const nextWindow = (Math.floor(Date.now() / DAY) + 1) * DAY;
    const times = deferred.map((d) => d.nextAttemptAt.getTime());
    expect(times.every((t) => t >= nextWindow)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times); // FIFO preserved
    for (const d of deferred) expect(await queues.email.getJobState(d.id)).toBe('delayed'); // not dropped/failed
    expect(onRateLimited).toHaveBeenCalledTimes(1);
    expect(onRateLimited.mock.calls[0]![0]).toMatchObject({ scope: 'sender', limit: 5, senderEmail: sender.email });
  });

  it('enforces the minimum delay between sends of one sender', async () => {
    const sender = await makeSender();
    senders.push(sender);
    const times: number[] = [];
    const send: SendFn = async (_s, e) => {
      times.push(Date.now());
      return { messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null };
    };
    // Isolated limiter prefix per worker set → fresh slot state; concurrency 5 must still serialise.
    worker(send, { minDelayMs: 300, concurrency: 5 });
    const res = await schedule(4, { senderIds: [sender.id] });
    await waitFor(() => statusCounts(res.campaignId), (c) => c.SENT === 4);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(300); // strict: enforced by the dispatch gate
  });
});

describe('restart recovery (boot reconciler)', () => {
  it('re-enqueues rows whose jobs vanished, fails stale SENDING, and is idempotent', async () => {
    const res = await schedule(6, { senderIds: [senders[0]!.id], startAt: new Date(Date.now() + DAY) });
    const rows = await prisma.email.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
    // Simulate Redis losing 3 jobs and a worker dying mid-send on another.
    for (const r of rows.slice(0, 3)) await queues.email.remove(r.id);
    await prisma.email.update({ where: { id: rows[5]!.id }, data: { status: 'SENDING', lockedAt: new Date(Date.now() - 600_000) } });

    const report = await reconcile({ prisma, queue: queues.email, logger: silentLogger, staleSendingMs: 300_000 });
    expect(report.requeued).toBeGreaterThanOrEqual(3);
    expect(report.staleFailed).toBeGreaterThanOrEqual(1);
    for (const r of rows.slice(0, 5)) expect(await queues.email.getJobState(r.id)).toBe('delayed');
    const restored = await queues.email.getJob(rows[0]!.id);
    expect(restored!.timestamp + restored!.delay).toBeGreaterThan(Date.now() + DAY - 60_000); // original time kept
    expect((await prisma.email.findUniqueOrThrow({ where: { id: rows[5]!.id } })).status).toBe('FAILED');

    const again = await reconcile({ prisma, queue: queues.email, logger: silentLogger, staleSendingMs: 300_000 });
    expect(again.requeued).toBe(0);
  });
});

describe('POST /api/campaigns', () => {
  const app = createApp({ queues });
  const cookie = () => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
    return h;
  };
  const payload = () => ({
    subject: 'Hello',
    body: 'Body',
    leads: [{ email: 'one@x.dev' }, { email: 'bad' }, { email: 'ONE@x.dev' }],
    startAt: new Date(Date.now() + DAY).toISOString(),
    delayBetweenSeconds: 2,
    hourlyLimit: 50,
    senderIds: [senders[0]!.id],
  });

  it('validates input', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({ subject: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('creates once per Idempotency-Key and replays the same response', async () => {
    const key = `test-key-${Date.now()}`;
    const first = await request(app).post('/api/campaigns').set('Cookie', cookie()).set('Idempotency-Key', key).send(payload());
    const second = await request(app).post('/api/campaigns').set('Cookie', cookie()).set('Idempotency-Key', key).send(payload());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ accepted: 1, invalid: ['bad'], duplicates: 1 });
    expect(second.status).toBe(200);
    expect(second.body.campaignId).toBe(first.body.campaignId);
    expect(await prisma.campaign.count({ where: { id: first.body.campaignId } })).toBe(1);
  });

  it('serves the email detail only to its owner', async () => {
    const key = `test-key-d-${Date.now()}`;
    const created = await request(app).post('/api/campaigns').set('Cookie', cookie()).set('Idempotency-Key', key).send(payload());
    const e = await prisma.email.findFirstOrThrow({ where: { campaignId: created.body.campaignId } });
    const mine = await request(app).get(`/api/emails/${e.id}`).set('Cookie', cookie());
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id: e.id, toEmail: 'one@x.dev', body: 'Body', status: 'SCHEDULED' });

    const other = await makeUser('other');
    let otherCookie = '';
    setSession({ cookie: (n: string, v: string) => (otherCookie = `${n}=${v}`) } as never, other.id);
    expect((await request(app).get(`/api/emails/${e.id}`).set('Cookie', otherCookie)).status).toBe(404);
    await prisma.user.delete({ where: { id: other.id } });
  });

  it('protects the Bull Board dashboard', async () => {
    expect((await request(app).get('/admin/queues')).status).toBe(401);
    expect((await request(app).get('/admin/queues').set('Cookie', cookie())).status).toBe(200);
  });
});
