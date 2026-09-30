import { Router } from 'express';
import { AssistantActionRefSchema, AssistantRequestSchema } from '@ri/shared';
import { env } from '../../config/env.js';
import { es } from '../../lib/elasticsearch.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import type { QueueSet } from '../../queues/queues.js';
import { RateLimiter } from '../../throttle/rateLimiter.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import type { EmailSearch } from '../search/emailSearch.js';
import { confirmAction, declineAction, handleMessage, starters, type AssistantDeps } from './engine.js';

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

/**
 * "Ask Inbox" (offline mode): rule-based answers and confirm-first actions. No external AI service —
 * every answer is computed from the caller's own data, and every change is proposed first and only
 * executed by POST /actions/:id/confirm.
 */
export function assistantRouter(queues: QueueSet, opts: { search?: EmailSearch; health?: AssistantDeps['health'] } = {}) {
  const deps: AssistantDeps = {
    prisma,
    redis,
    queues,
    limiter: new RateLimiter(redis, { prefix: '', windowMs: env.RATE_WINDOW_SECONDS * 1000, minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS }),
    config: { perSenderDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER },
    search: opts.search,
    health: opts.health ?? (async () => {
      const [db, r, e] = await Promise.all([ok(prisma.$queryRaw`SELECT 1`), ok(redis.ping()), ok(es.ping())]);
      return { db, redis: r, elasticsearch: e };
    }),
  };

  const router = Router();
  router.use(requireAuth);

  // POST /api/assistant/message { message, context?, timezone? } → AssistantReply
  router.post('/message', async (req, res, next) => {
    try {
      res.json(await handleMessage(authedUserId(req), AssistantRequestSchema.parse(req.body), deps));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/assistant/starters → prompts tuned to what needs attention right now
  router.get('/starters', async (req, res, next) => {
    try {
      res.json({ suggestions: await starters(authedUserId(req), deps) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/assistant/actions/:id/confirm | cancel
  router.post('/actions/:id/confirm', async (req, res, next) => {
    try {
      const { id } = AssistantActionRefSchema.parse({ id: req.params.id });
      res.json(await confirmAction(authedUserId(req), id, deps));
    } catch (err) {
      next(err);
    }
  });
  router.post('/actions/:id/cancel', async (req, res, next) => {
    try {
      const { id } = AssistantActionRefSchema.parse({ id: req.params.id });
      res.json(await declineAction(authedUserId(req), id, deps));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
