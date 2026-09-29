import { Router } from 'express';
import { CreateCampaignInputSchema } from '@ri/shared';
import { env } from '../../config/env.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import type { QueueSet } from '../../queues/queues.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { cancelCampaign, listCampaigns, pauseCampaign, resumeCampaign } from './controls.js';
import { createCampaign } from './service.js';

export function campaignsRouter(queues: QueueSet) {
  const router = Router();
  router.use(requireAuth);

  // POST /api/campaigns — validate, persist, enqueue delayed jobs.
  router.post('/', async (req, res, next) => {
    try {
      const userId = authedUserId(req);
      const input = CreateCampaignInputSchema.parse(req.body);
      const { replayed, body } = await withIdempotency(redis, userId, req.header('Idempotency-Key'), () =>
        createCampaign(userId, input, {
          prisma,
          queues,
          redis,
          config: {
            maxPerWindowGlobal: env.MAX_EMAILS_PER_HOUR,
            maxPerWindowPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
            minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
            windowMs: env.RATE_WINDOW_SECONDS * 1000,
          },
        }),
      );
      res.status(replayed ? 200 : 201).json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      res.json(await listCampaigns(authedUserId(req), prisma));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/campaigns/:id/pause | resume | cancel (feature F3)
  const actions = { pause: pauseCampaign, resume: resumeCampaign, cancel: cancelCampaign };
  router.post('/:id/:action(pause|resume|cancel)', async (req, res, next) => {
    try {
      await actions[req.params.action as keyof typeof actions](authedUserId(req), req.params.id!, { prisma, queues, redis });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
