import type { EmailEventType, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { CampaignStatus, CampaignSummary } from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { publishLive } from '../../lib/live.js';
import { enqueueEmails, enqueueIndex, type QueueSet } from '../../queues/queues.js';

export type ControlDeps = { prisma: PrismaClient; queues: QueueSet; redis: Redis };

const PENDING = ['SCHEDULED', 'RATE_LIMITED'] as const;

/** Removes jobs by id; a job that is mid-send (locked) can't be removed, and the processor's
 *  campaign-status check covers it. */
async function removeJobs(queues: QueueSet, ids: string[]) {
  for (let i = 0; i < ids.length; i += 200) {
    await Promise.all(ids.slice(i, i + 200).map((id) => queues.email.remove(id).catch(() => 0)));
  }
}

async function recordAndNotify(
  deps: ControlDeps,
  userId: string,
  ids: string[],
  type: EmailEventType,
  reindex: boolean,
) {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 1000) {
    await deps.prisma.emailEvent.createMany({
      data: ids.slice(i, i + 1000).map((emailId) => ({ emailId, userId, type })),
    });
  }
  if (reindex) await enqueueIndex(deps.queues.index, ids);
}

async function ownCampaign(prisma: PrismaClient, userId: string, id: string) {
  const c = await prisma.campaign.findFirst({ where: { id, userId } });
  if (!c) throw AppError.notFound('Campaign not found');
  return c;
}

const conflict = (msg: string) => new AppError(409, 'CONFLICT', msg);

export async function pauseCampaign(userId: string, id: string, deps: ControlDeps) {
  const c = await ownCampaign(deps.prisma, userId, id);
  if (c.status !== 'ACTIVE') throw conflict(`Campaign is ${c.status.toLowerCase()}`);
  await deps.prisma.campaign.update({ where: { id }, data: { status: 'PAUSED' } });
  const rows = await deps.prisma.email.findMany({ where: { campaignId: id, status: { in: [...PENDING] } }, select: { id: true } });
  const ids = rows.map((r) => r.id);
  await removeJobs(deps.queues, ids);
  await recordAndNotify(deps, userId, ids, 'PAUSED', false);
  await publishLive(deps.redis, userId, { type: 'campaign.updated', campaignId: id, status: 'PAUSED' });
}

/** Re-enqueues every pending email with its original jobId, in sequence order. Anything whose
 *  time passed during the pause runs immediately — still through the rate limiter. */
export async function resumeCampaign(userId: string, id: string, deps: ControlDeps) {
  const c = await ownCampaign(deps.prisma, userId, id);
  if (c.status !== 'PAUSED') throw conflict(`Campaign is ${c.status.toLowerCase()}, not paused`);
  await deps.prisma.campaign.update({ where: { id }, data: { status: 'ACTIVE' } });
  const rows = await deps.prisma.email.findMany({
    where: { campaignId: id, status: { in: [...PENDING] } },
    select: { id: true, nextAttemptAt: true },
    orderBy: { sequence: 'asc' },
  });
  const ids = rows.map((r) => r.id);
  await removeJobs(deps.queues, ids); // clear any job that completed as "paused" so the id can be reused
  await enqueueEmails(deps.queues.email, rows);
  await recordAndNotify(deps, userId, ids, 'RESUMED', false);
  await publishLive(deps.redis, userId, { type: 'campaign.updated', campaignId: id, status: 'ACTIVE' });
}

export async function cancelCampaign(userId: string, id: string, deps: ControlDeps) {
  const c = await ownCampaign(deps.prisma, userId, id);
  if (c.status === 'CANCELLED') throw conflict('Campaign is already cancelled');
  await deps.prisma.campaign.update({ where: { id }, data: { status: 'CANCELLED' } });
  const rows = await deps.prisma.email.findMany({ where: { campaignId: id, status: { in: [...PENDING] } }, select: { id: true } });
  const ids = rows.map((r) => r.id);
  await deps.prisma.email.updateMany({ where: { id: { in: ids }, status: { in: [...PENDING] } }, data: { status: 'CANCELLED' } });
  await removeJobs(deps.queues, ids);
  await recordAndNotify(deps, userId, ids, 'CANCELLED', true);
  await publishLive(deps.redis, userId, { type: 'campaign.updated', campaignId: id, status: 'CANCELLED' });
}

/** FAILED → SCHEDULED, sent as soon as the limiter allows. The old failed job is replaced
 *  (same jobId), so there is still exactly one job per email. */
export async function retryEmail(userId: string, emailId: string, deps: ControlDeps) {
  const e = await deps.prisma.email.findFirst({ where: { id: emailId, userId }, include: { campaign: true } });
  if (!e) throw AppError.notFound('Email not found');
  if (e.status !== 'FAILED') throw conflict('Only failed emails can be retried');
  if (e.campaign.status === 'CANCELLED') throw conflict('Its campaign was cancelled');
  const now = new Date();
  const updated = await deps.prisma.email.updateMany({
    where: { id: emailId, status: 'FAILED' },
    data: { status: 'SCHEDULED', nextAttemptAt: now, failedAt: null, lastError: null, lockedAt: null },
  });
  if (updated.count === 0) throw conflict('Email changed, refresh and try again');
  await deps.queues.email.remove(emailId).catch(() => 0);
  if (e.campaign.status === 'ACTIVE') await enqueueEmails(deps.queues.email, [{ id: emailId, nextAttemptAt: now }]);
  await recordAndNotify(deps, userId, [emailId], 'RETRIED', true);
  await publishLive(deps.redis, userId, { type: 'email.updated', emailId, campaignId: e.campaignId, status: 'SCHEDULED' });
}

export async function cancelEmail(userId: string, emailId: string, deps: ControlDeps) {
  const e = await deps.prisma.email.findFirst({ where: { id: emailId, userId } });
  if (!e) throw AppError.notFound('Email not found');
  const updated = await deps.prisma.email.updateMany({
    where: { id: emailId, status: { in: [...PENDING] } },
    data: { status: 'CANCELLED' },
  });
  if (updated.count === 0) throw conflict('Only scheduled emails can be cancelled');
  await deps.queues.email.remove(emailId).catch(() => 0);
  await recordAndNotify(deps, userId, [emailId], 'CANCELLED', true);
  await publishLive(deps.redis, userId, { type: 'email.updated', emailId, campaignId: e.campaignId, status: 'CANCELLED' });
}

/** Campaign cards: per-status counts in one grouped query; "completed" is derived, not stored. */
export async function listCampaigns(userId: string, prisma: PrismaClient): Promise<CampaignSummary[]> {
  const campaigns = await prisma.campaign.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  if (campaigns.length === 0) return [];
  const ids = campaigns.map((c) => c.id);
  const [grouped, pendingMax] = await Promise.all([
    prisma.email.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } }),
    prisma.email.groupBy({
      by: ['campaignId'],
      where: { campaignId: { in: ids }, status: { in: [...PENDING] } },
      _max: { nextAttemptAt: true },
    }),
  ]);
  const count = (id: string, status: string) =>
    grouped.find((g) => g.campaignId === id && g.status === status)?._count._all ?? 0;

  return campaigns.map((c) => {
    const counts = {
      scheduled: count(c.id, 'SCHEDULED'),
      rateLimited: count(c.id, 'RATE_LIMITED'),
      sending: count(c.id, 'SENDING'),
      sent: count(c.id, 'SENT'),
      failed: count(c.id, 'FAILED'),
      cancelled: count(c.id, 'CANCELLED'),
    };
    const pending = counts.scheduled + counts.rateLimited + counts.sending;
    const status: CampaignStatus = c.status === 'ACTIVE' && pending === 0 ? 'COMPLETED' : c.status;
    return {
      id: c.id,
      subject: c.subject,
      status,
      createdAt: c.createdAt.toISOString(),
      startAt: c.startAt.toISOString(),
      delayBetweenMs: c.delayBetweenMs,
      hourlyLimit: c.hourlyLimit,
      total: c.totalRecipients,
      counts,
      lastPendingAt: pendingMax.find((p) => p.campaignId === c.id)?._max.nextAttemptAt?.toISOString() ?? null,
    };
  });
}
