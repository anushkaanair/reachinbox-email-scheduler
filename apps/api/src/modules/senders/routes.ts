import { Router } from 'express';
import type { Sender } from '@ri/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { RateLimiter } from '../../throttle/rateLimiter.js';
import { requireAuth } from '../auth/session.js';

export const sendersRouter = Router();
sendersRouter.use(requireAuth);

// Read-only view of the worker's counters (same keys, same window maths).
const limiter = new RateLimiter(redis, {
  prefix: '',
  windowMs: env.RATE_WINDOW_SECONDS * 1000,
  minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
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
