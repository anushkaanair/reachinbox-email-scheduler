import { Router } from 'express';
import type { Health } from '@ri/shared';
import { es } from '../../lib/elasticsearch.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

export const healthRouter = Router();

const ok = async (p: Promise<unknown>) => p.then(() => true, () => false);

healthRouter.get('/', async (_req, res) => {
  const [db, r, e] = await Promise.all([
    ok(prisma.$queryRaw`SELECT 1`),
    ok(redis.ping()),
    ok(es.ping()),
  ]);
  // ES is not on the critical send path, so it only degrades the status.
  const body: Health = { status: db && r && e ? 'ok' : 'degraded', db, redis: r, elasticsearch: e };
  res.status(db && r ? 200 : 503).json(body);
});
