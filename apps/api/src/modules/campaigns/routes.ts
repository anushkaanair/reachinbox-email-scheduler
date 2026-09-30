import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import {
  CreateCampaignInputSchema,
  PreflightInputSchema,
  renderTemplate,
  spin,
  TestSendInputSchema,
  type TestSendResponse,
} from '@ri/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sendViaSmtp, type SendFn } from '../../mail/transport.js';
import type { QueueSet } from '../../queues/queues.js';
import { RateLimiter } from '../../throttle/rateLimiter.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { cancelCampaign, listCampaigns, pauseCampaign, resumeCampaign, retryFailed } from './controls.js';
import { preflight } from './preflight.js';
import { createCampaign, loadSenders, type SchedulingConfig } from './service.js';

const config: SchedulingConfig = {
  maxPerWindowGlobal: env.MAX_EMAILS_PER_HOUR,
  maxPerWindowPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
  minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
  windowMs: env.RATE_WINDOW_SECONDS * 1000,
};

export function campaignsRouter(queues: QueueSet, opts: { send?: SendFn } = {}) {
  const send = opts.send ?? sendViaSmtp;
  // Same keys and window maths as the worker's limiter, so forecasts and the send gate agree.
  const limiter = new RateLimiter(redis, { prefix: '', windowMs: config.windowMs, minDelayMs: config.minDelayMs });
  const router = Router();
  router.use(requireAuth);

  // POST /api/campaigns — validate, persist, enqueue delayed jobs.
  router.post('/', async (req, res, next) => {
    try {
      const userId = authedUserId(req);
      const input = CreateCampaignInputSchema.parse(req.body);
      const { replayed, body } = await withIdempotency(redis, userId, req.header('Idempotency-Key'), () =>
        createCampaign(userId, input, { prisma, queues, redis, config, limiter }),
      );
      res.status(replayed ? 200 : 201).json(body);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/campaigns/preflight — read-only report + window-by-window forecast for the composer.
  router.post('/preflight', async (req, res, next) => {
    try {
      const input = PreflightInputSchema.parse(req.body);
      res.json(await preflight(authedUserId(req), input, { prisma, config, limiter }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/campaigns/test-send — one real email, rendered for a sample lead, to the sender's own
  // Ethereal inbox (so the preview link works). It honours the sender's minimum delay.
  router.post('/test-send', async (req, res, next) => {
    try {
      const input = TestSendInputSchema.parse(req.body);
      const [sender] = input.senderId
        ? await prisma.sender.findMany({ where: { id: input.senderId, isActive: true }, take: 1 })
        : (await loadSenders(prisma)).slice(0, 1);
      if (!sender) throw new AppError(409, 'CONFLICT', 'No active sender to test with');

      const wait = await limiter.gate(sender.id, Date.now());
      if (wait > 0) {
        throw new AppError(429, 'RATE_LIMITED', `That sender just sent an email — try again in ${Math.ceil((wait - Date.now()) / 1000)}s`);
      }

      const vars = { email: input.sample?.email ?? sender.email, name: input.sample?.name ?? '', ...input.sample?.vars };
      const seed = input.sample?.email ?? sender.email; // same variant the lead will get
      const subject = `[TEST] ${renderTemplate(spin(input.subject, seed), vars)}`;
      const result = await send(sender, {
        emailId: randomUUID(),
        to: sender.email,
        toName: null,
        subject,
        body: renderTemplate(spin(input.body, seed), vars),
      }).catch(() => {
        throw new AppError(503, 'UNAVAILABLE', 'Couldn’t send the test email — check the sender’s SMTP account');
      });
      const body: TestSendResponse = { to: sender.email, subject, previewUrl: result.previewUrl };
      res.json(body);
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

  const controls = { prisma, queues, redis };

  // POST /api/campaigns/:id/retry-failed → { retried }
  router.post('/:id/retry-failed', async (req, res, next) => {
    try {
      res.json({ retried: await retryFailed(authedUserId(req), req.params.id!, controls) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/campaigns/:id/pause | resume | cancel (feature F3)
  const actions = { pause: pauseCampaign, resume: resumeCampaign, cancel: cancelCampaign };
  router.post('/:id/:action(pause|resume|cancel)', async (req, res, next) => {
    try {
      await actions[req.params.action as keyof typeof actions](authedUserId(req), req.params.id!, controls);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
