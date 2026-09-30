import { randomUUID } from 'node:crypto';
import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bounceVerdict, DEFAULT_BOUNCE_PROTECTION } from '@ri/shared';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import type { SendFn } from '../src/mail/transport.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { listCampaigns, resumeCampaign } from '../src/modules/campaigns/controls.js';
import { createEmailProcessor, type CampaignPausedNotice } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const HOUR = 3_600_000;

describe('bounceVerdict (shared)', () => {
  const p = { thresholdPercent: 10, minSends: 20 };
  it('needs a minimum sample before judging', () => {
    expect(bounceVerdict({ sent: 0, bounced: 0 }, p)).toEqual({ attempts: 0, ratePercent: null, breached: false });
    expect(bounceVerdict({ sent: 0, bounced: 5 }, p)).toMatchObject({ ratePercent: 100, breached: false }); // 5 < 20
    expect(bounceVerdict({ sent: 10, bounced: 10 }, p).breached).toBe(true);
  });
  it('trips only when the rate is over the threshold, not at it', () => {
    expect(bounceVerdict({ sent: 18, bounced: 2 }, p)).toMatchObject({ ratePercent: 10, breached: false });
    expect(bounceVerdict({ sent: 17, bounced: 3 }, p).breached).toBe(true);
  });
  it('threshold 0 switches it off', () => {
    expect(bounceVerdict({ sent: 0, bounced: 100 }, { thresholdPercent: 0, minSends: 1 }).breached).toBe(false);
  });
  it('defaults are 10% after 20 emails', () => expect(DEFAULT_BOUNCE_PROTECTION).toEqual(p));
});

describe('worker: bounce protection', () => {
  const conn = createRedis('test-bounce');
  const queues = createQueues(conn, testPrefix());
  let userId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: HOUR };

  beforeAll(async () => {
    userId = (await makeUser('bounce')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });

  const job = (emailId: string) => {
    const j = { id: emailId, data: { emailId } as EmailJobData, opts: { attempts: 3 }, attemptsMade: 0, updateData: vi.fn(async (d: EmailJobData) => void (j.data = d)), moveToDelayed: vi.fn(async () => {}), discard: vi.fn() };
    return j as unknown as Job<EmailJobData>;
  };
  async function setup(n: number, bounceProtection?: { thresholdPercent: number; minSends: number }) {
    const s = await makeSender();
    senderIds.push(s.id);
    const c = await createCampaign(userId, { subject: 'Hello', body: 'b', leads: Array.from({ length: n }, (_, i) => ({ email: `b${i}-${randomUUID().slice(0, 6)}@x.dev` })), startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 1000, senderIds: [s.id], bounceProtection }, { prisma, queues, config: cfg });
    const rows = await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } });
    const paused = vi.fn(async (_n: CampaignPausedNotice) => {});
    const run = (send: SendFn) =>
      createEmailProcessor({
        prisma,
        limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: HOUR, minDelayMs: 0 }),
        send,
        logger: silentLogger,
        config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000, pauseAfterFailures: 99, pauseMs: 60_000 },
        onRateLimited: async () => {},
        onCampaignPaused: paused,
      });
    return { campaignId: c.campaignId, rows, paused, run };
  }
  const ok: SendFn = async (_s, e) => ({ messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null });
  const bounce: SendFn = async () => {
    throw new Error('550 5.1.1 User unknown');
  };
  const status = async (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

  it('stores the campaign’s settings, defaulting to 10% after 20 emails', async () => {
    const a = await setup(1);
    expect(await status(a.campaignId)).toMatchObject({ bounceThresholdPercent: 10, bounceMinSends: 20, pauseReason: null });
    const b = await setup(1, { thresholdPercent: 35, minSends: 4 });
    expect(await status(b.campaignId)).toMatchObject({ bounceThresholdPercent: 35, bounceMinSends: 4 });
  });

  it('pauses once, tells the owner, and leaves the rest waiting (not dropped)', async () => {
    const t = await setup(6, { thresholdPercent: 40, minSends: 3 });
    const p = t.run(ok);
    await p(job(t.rows[0]!.id), 't'); // sent: 1 attempt
    await t.run(bounce)(job(t.rows[1]!.id), 't').catch(() => undefined); // 1 bounce of 2 → below min sample
    expect((await status(t.campaignId)).status).toBe('ACTIVE');
    await t.run(bounce)(job(t.rows[2]!.id), 't').catch(() => undefined); // 2 of 3 = 66% ≥ min 3 → over 40%
    const c = await status(t.campaignId);
    expect(c).toMatchObject({ status: 'PAUSED', pauseReason: 'BOUNCE_PROTECTION' });
    expect(t.paused).toHaveBeenCalledTimes(1);
    expect(t.paused.mock.calls[0]![0]).toMatchObject({ campaignId: t.campaignId, userId, subject: 'Hello', threshold: 40, bounced: 2, attempts: 3, bounceRate: 66.7 });

    // Another bounce after the pause must not alert again; the remaining emails stay scheduled.
    await t.run(bounce)(job(t.rows[3]!.id), 't').catch(() => undefined);
    const after = await prisma.email.findMany({ where: { campaignId: t.campaignId }, orderBy: { sequence: 'asc' } });
    expect(after.slice(4).every((e) => e.status === 'SCHEDULED')).toBe(true);
    expect(after.filter((e) => e.bouncedAt).length).toBeGreaterThanOrEqual(2);
    expect(t.paused).toHaveBeenCalledTimes(1);
    expect(await prisma.emailEvent.count({ where: { emailId: { in: after.slice(4).map((e) => e.id) }, type: 'PAUSED' } })).toBe(2);

    // A paused campaign's remaining jobs skip instead of sending.
    const send = vi.fn(ok);
    expect(await t.run(send)(job(after[4]!.id), 't')).toEqual({ outcome: 'skipped', reason: 'campaign_paused' });
    expect(send).not.toHaveBeenCalled();
  });

  it('the campaign list reports the bounce rate, the reason, and nothing is blocked', async () => {
    const t = await setup(4, { thresholdPercent: 10, minSends: 2 });
    await t.run(bounce)(job(t.rows[0]!.id), 't').catch(() => undefined);
    await t.run(bounce)(job(t.rows[1]!.id), 't').catch(() => undefined);
    const row = (await listCampaigns(userId, prisma)).find((c) => c.id === t.campaignId)!;
    expect(row).toMatchObject({ status: 'PAUSED', pauseReason: 'BOUNCE_PROTECTION', bounced: 2, bounceRate: 100, bounceProtection: { thresholdPercent: 10, minSends: 2 }, senderBlocked: null });
  });

  it('resume clears the reason and re-queues the waiting emails', async () => {
    const t = await setup(4, { thresholdPercent: 10, minSends: 2 });
    await t.run(bounce)(job(t.rows[0]!.id), 't').catch(() => undefined);
    await t.run(bounce)(job(t.rows[1]!.id), 't').catch(() => undefined);
    expect((await status(t.campaignId)).status).toBe('PAUSED');
    await resumeCampaign(userId, t.campaignId, { prisma, queues, redis });
    expect(await status(t.campaignId)).toMatchObject({ status: 'ACTIVE', pauseReason: null });
    expect(await queues.email.getJob(t.rows[2]!.id)).toBeTruthy();
  });

  it('threshold 0 never pauses, however many bounce', async () => {
    const t = await setup(4, { thresholdPercent: 0, minSends: 1 });
    for (const r of t.rows) await t.run(bounce)(job(r.id), 't').catch(() => undefined);
    expect((await status(t.campaignId)).status).toBe('ACTIVE');
    expect(t.paused).not.toHaveBeenCalled();
  });

  it('a campaign whose senders are all paused says so', async () => {
    const t = await setup(2);
    const senderId = t.rows[0]!.senderId;
    await prisma.sender.update({ where: { id: senderId }, data: { pausedUntil: new Date(Date.now() + HOUR), pauseReason: 'test' } });
    expect((await listCampaigns(userId, prisma)).find((c) => c.id === t.campaignId)!.senderBlocked).toBe('PAUSED');
    await prisma.sender.update({ where: { id: senderId }, data: { pausedUntil: null } });
    expect((await listCampaigns(userId, prisma)).find((c) => c.id === t.campaignId)!.senderBlocked).toBeNull();
  });
});
