import { Prisma, type PrismaClient, type Sender } from '@prisma/client';
import {
  isAuthError,
  isHardBounce,
  senderHealth,
  warmupCap,
  warmupDay,
  warmupPlan,
  DnsReportSchema,
  type SenderDetail,
} from '@ri/shared';
import type { RateLimiter } from '../../throttle/rateLimiter.js';

export const HEALTH_WINDOW_DAYS = 7;

type Stat = { sent: number; failed: number; deferred: number; hardBounces: number };

/** Sends, failures, bounces and limit deferrals per sender over the health window. */
async function recentStats(prisma: PrismaClient, senderIds: string[], since: Date): Promise<Map<string, Stat>> {
  const out = new Map<string, Stat>(senderIds.map((id) => [id, { sent: 0, failed: 0, deferred: 0, hardBounces: 0 }]));
  if (senderIds.length === 0) return out;
  const [statuses, failures, deferrals] = await Promise.all([
    prisma.email.groupBy({ by: ['senderId', 'status'], where: { senderId: { in: senderIds }, status: { in: ['SENT', 'FAILED'] }, updatedAt: { gte: since } }, _count: { _all: true } }),
    prisma.email.groupBy({ by: ['senderId', 'lastError'], where: { senderId: { in: senderIds }, status: 'FAILED', updatedAt: { gte: since } }, _count: { _all: true } }),
    prisma.$queryRaw<{ senderId: string; n: bigint }[]>(Prisma.sql`
      SELECT e."senderId", count(*) AS n FROM "EmailEvent" v JOIN "Email" e ON e.id = v."emailId"
       WHERE v.type = 'RATE_LIMITED' AND v.at >= ${since} AND e."senderId" IN (${Prisma.join(senderIds)})
       GROUP BY 1`),
  ]);
  for (const g of statuses) {
    const s = out.get(g.senderId)!;
    if (g.status === 'SENT') s.sent += g._count._all;
    else s.failed += g._count._all;
  }
  for (const f of failures) if (f.lastError && isHardBounce(f.lastError)) out.get(f.senderId)!.hardBounces += f._count._all;
  for (const d of deferrals) out.get(d.senderId)!.deferred += Number(d.n);
  return out;
}

/** Everything the Senders page shows for each active sender. */
export async function senderDetails(
  prisma: PrismaClient,
  limiter: RateLimiter,
  opts: { perSenderDefault: number; now?: number },
): Promise<SenderDetail[]> {
  const now = opts.now ?? Date.now();
  const senders = await prisma.sender.findMany({ where: { isActive: true }, orderBy: { email: 'asc' } });
  const ids = senders.map((s) => s.id);
  const stats = await recentStats(prisma, ids, new Date(now - HEALTH_WINDOW_DAYS * 86_400_000));
  const extras = await accountExtras(prisma, ids, now);
  return Promise.all(senders.map(async (s) => toDetail(s, stats.get(s.id)!, extras.get(s.id)!, limiter, opts.perSenderDefault, now)));
}

type Extras = { bouncedToday: number; campaignCount: number };

/** Bounces since 00:00 UTC (the same day boundary the daily counters use) and how many campaigns used each account. */
async function accountExtras(prisma: PrismaClient, senderIds: string[], now: number): Promise<Map<string, Extras>> {
  const out = new Map<string, Extras>(senderIds.map((id) => [id, { bouncedToday: 0, campaignCount: 0 }]));
  if (senderIds.length === 0) return out;
  const dayStart = new Date(Math.floor(now / 86_400_000) * 86_400_000);
  const [failed, campaigns] = await Promise.all([
    prisma.email.groupBy({ by: ['senderId', 'lastError'], where: { senderId: { in: senderIds }, status: 'FAILED', updatedAt: { gte: dayStart } }, _count: { _all: true } }),
    prisma.email.groupBy({ by: ['senderId', 'campaignId'], where: { senderId: { in: senderIds } } }),
  ]);
  for (const f of failed) if (f.lastError && isHardBounce(f.lastError)) out.get(f.senderId)!.bouncedToday += f._count._all;
  for (const c of campaigns) out.get(c.senderId)!.campaignCount += 1;
  return out;
}

async function toDetail(s: Sender, st: Stat, extra: Extras, limiter: RateLimiter, perSenderDefault: number, now: number): Promise<SenderDetail> {
  const paused = (s.pausedUntil?.getTime() ?? 0) > now;
  const settings = { start: s.warmupStart, increment: s.warmupIncrement, target: s.warmupTarget };
  const warming = s.warmupEnabled && s.warmupStartedAt !== null;
  const day = warming ? warmupDay(s.warmupStartedAt!.getTime(), now, limiter.dayMs) : null;
  const capToday = day !== null ? warmupCap(settings, day) : null;
  const health = senderHealth({
    ...st,
    consecutiveFailures: s.consecutiveFailures,
    paused,
    authError: Boolean(s.lastError && isAuthError(s.lastError) && s.consecutiveFailures > 0),
  });
  // The pause banner already shows the reason, so the reasons list doesn't repeat it.
  const [usedThisWindow, sentToday] = await Promise.all([limiter.senderUsage(s.id, now), limiter.senderDailyUsage(s.id, now)]);
  return {
    id: s.id,
    email: s.email,
    displayName: s.displayName,
    isActive: s.isActive,
    hourlyLimit: s.hourlyLimit ?? perSenderDefault,
    provider: (['GOOGLE', 'OUTLOOK', 'CUSTOM', 'ETHEREAL'].includes(s.provider) ? s.provider : 'CUSTOM') as SenderDetail['provider'],
    firstName: s.firstName || s.displayName,
    lastName: s.lastName,
    dailyLimit: s.dailyLimit,
    hourlyLimitOverride: s.hourlyLimit,
    minDelaySeconds: s.minDelayMs === null ? null : Math.round(s.minDelayMs / 1000),
    signature: s.signature,
    replyTo: s.replyTo,
    tags: s.tags,
    bouncedToday: extra.bouncedToday,
    campaignCount: extra.campaignCount,
    dns: DnsReportSchema.safeParse(s.dnsResult).data ?? null,
    lastTest: s.lastTestAt && s.lastTestOk !== null ? { at: s.lastTestAt.toISOString(), ok: s.lastTestOk } : null,
    attention: paused ? 'paused' : s.lastError && s.consecutiveFailures > 0 ? 'error' : null,
    usedThisWindow,
    sentToday,
    health,
    stats: st,
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    pausedUntil: paused ? s.pausedUntil!.toISOString() : null,
    pauseReason: paused ? s.pauseReason : null,
    warmup: {
      enabled: s.warmupEnabled,
      settings,
      startedAt: s.warmupStartedAt?.toISOString() ?? null,
      day,
      capToday,
      complete: warming && capToday === null,
      plan: warmupPlan(settings),
    },
    dayLengthSeconds: Math.round(limiter.dayMs / 1000),
    healthWindowDays: HEALTH_WINDOW_DAYS,
  };
}
