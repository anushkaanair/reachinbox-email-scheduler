import { Router } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Analytics } from '@ri/shared';
import type { RateLimiter } from '../../throttle/rateLimiter.js';
import { authedUserId, requireAuth } from '../auth/session.js';

const QuerySchema = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) });

type Bucket = { hour: Date; kind: 'sent' | 'failed' | 'rateLimited'; n: bigint };

/**
 * GET /api/analytics?hours=24 — hourly sent / failed / rate-limit deferrals for the chart,
 * totals, and live per-sender quota usage for the "health" meters.
 * Sent/failed come from the Email rows (complete history); deferrals from the event log.
 */
export function analyticsRouter(deps: { prisma: PrismaClient; limiter: RateLimiter; perSenderDefault: number; windowSeconds: number }) {
  const { prisma, limiter } = deps;
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const userId = authedUserId(req);
      const { hours } = QuerySchema.parse(req.query);
      const since = new Date(Date.now() - hours * 3_600_000);

      const [buckets, pending, senders, sentBySender] = await Promise.all([
        prisma.$queryRaw<Bucket[]>(Prisma.sql`
          SELECT date_trunc('hour', "sentAt") AS hour, 'sent' AS kind, count(*) AS n
            FROM "Email" WHERE "userId" = ${userId} AND status = 'SENT' AND "sentAt" >= ${since} GROUP BY 1
          UNION ALL
          SELECT date_trunc('hour', "failedAt"), 'failed', count(*)
            FROM "Email" WHERE "userId" = ${userId} AND status = 'FAILED' AND "failedAt" >= ${since} GROUP BY 1
          UNION ALL
          SELECT date_trunc('hour', at), 'rateLimited', count(*)
            FROM "EmailEvent" WHERE "userId" = ${userId} AND type = 'RATE_LIMITED' AND at >= ${since} GROUP BY 1`),
        prisma.email.count({ where: { userId, status: { in: ['SCHEDULED', 'RATE_LIMITED', 'SENDING'] } } }),
        prisma.sender.findMany({ where: { isActive: true }, orderBy: { email: 'asc' } }),
        prisma.email.groupBy({ by: ['senderId'], where: { userId, status: 'SENT', sentAt: { gte: since } }, _count: { _all: true } }),
      ]);

      // Dense series: one point per hour, zero-filled, oldest first.
      const start = new Date(since);
      start.setUTCMinutes(0, 0, 0); // Postgres date_trunc buckets are UTC hours (matters in e.g. IST, +5:30)
      const series = new Map<number, { sent: number; failed: number; rateLimited: number }>();
      for (let t = start.getTime(); t <= Date.now(); t += 3_600_000) series.set(t, { sent: 0, failed: 0, rateLimited: 0 });
      const totals = { sent: 0, failed: 0, rateLimited: 0, pending };
      for (const b of buckets) {
        const n = Number(b.n);
        totals[b.kind] += n;
        const point = series.get(new Date(b.hour).getTime());
        if (point) point[b.kind] += n;
      }

      const body: Analytics = {
        hours,
        windowSeconds: deps.windowSeconds,
        totals,
        hourly: [...series].map(([t, v]) => ({ hour: new Date(t).toISOString(), ...v })),
        senders: await Promise.all(
          senders.map(async (s) => ({
            id: s.id,
            email: s.email,
            used: await limiter.senderUsage(s.id),
            limit: s.hourlyLimit ?? deps.perSenderDefault,
            sent24h: sentBySender.find((x) => x.senderId === s.id)?._count._all ?? 0,
          })),
        ),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
