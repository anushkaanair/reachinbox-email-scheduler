import { Router } from 'express';
import { WarmupUpdateSchema, type Sender } from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { senderDetails } from './health.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { RateLimiter } from '../../throttle/rateLimiter.js';
import { requireAdmin, requireAuth } from '../auth/session.js';

export const sendersRouter = Router();
sendersRouter.use(requireAuth);

// Read-only view of the worker's counters (same keys, same window maths).
const limiter = new RateLimiter(redis, {
  prefix: '',
  windowMs: env.RATE_WINDOW_SECONDS * 1000,
  minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
  dayMs: env.WARMUP_DAY_SECONDS * 1000,
});

// GET /api/senders — active senders with their effective limit and usage in the current window.
sendersRouter.get('/', async (_req, res, next) => {
  try {
    const senders = await prisma.sender.findMany({ where: { isActive: true }, orderBy: { email: 'asc' } });
    const body: Sender[] = await Promise.all(
      senders.map(async (s) => ({
        id: s.id,
        email: s.email,
        displayName: s.displayName,
        isActive: s.isActive,
        hourlyLimit: s.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        usedThisWindow: await limiter.senderUsage(s.id),
      })),
    );
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /api/senders/health — health score, warm-up ramp and pause state for every active sender.
sendersRouter.get('/health', async (_req, res, next) => {
  try {
    res.json(await senderDetails(prisma, limiter, { perSenderDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER }));
  } catch (err) {
    next(err);
  }
});

async function activeSender(id: string) {
  const s = await prisma.sender.findFirst({ where: { id, isActive: true } });
  if (!s) throw AppError.notFound('Sender not found');
  return s;
}

// POST /api/senders/:id/resume — lift a circuit-breaker pause now. Senders are shared, so admin-only
// (ADMIN_EMAILS; any signed-in user when it isn't set).
sendersRouter.post('/:id/resume', requireAdmin, async (req, res, next) => {
  try {
    await activeSender(req.params.id!);
    await prisma.sender.update({ where: { id: req.params.id }, data: { pausedUntil: null, pauseReason: null, consecutiveFailures: 0 } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PUT /api/senders/:id/warmup { enabled, settings?, restart? }
sendersRouter.put('/:id/warmup', requireAdmin, async (req, res, next) => {
  try {
    const s = await activeSender(req.params.id!);
    const body = WarmupUpdateSchema.parse(req.body);
    const startNow = body.enabled && (body.restart || !s.warmupEnabled || !s.warmupStartedAt);
    await prisma.sender.update({
      where: { id: s.id },
      data: {
        warmupEnabled: body.enabled,
        ...(body.settings ? { warmupStart: body.settings.start, warmupIncrement: body.settings.increment, warmupTarget: body.settings.target } : {}),
        ...(startNow ? { warmupStartedAt: new Date() } : {}),
      },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
