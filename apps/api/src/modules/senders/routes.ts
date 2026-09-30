import { Router } from 'express';
import {
  BulkActionSchema,
  ImportRequestSchema,
  ReconnectSchema,
  SenderCreateSchema,
  SenderSettingsSchema,
  TestEmailSchema,
  WarmupUpdateSchema,
  type Sender,
} from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { senderDetails } from './health.js';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sendViaSmtp, type SendFn } from '../../mail/transport.js';
import { RateLimiter } from '../../throttle/rateLimiter.js';
import { requireAdmin, requireAuth } from '../auth/session.js';
import type { Resolver } from './dns.js';
import {
  acknowledgeError,
  bulkAction,
  createAccount,
  importAccounts,
  reconnectAccount,
  runDnsCheck,
  settingsData,
  testAccount,
  type AccountDeps,
} from './service.js';
import { verifySmtp, type SmtpVerifier } from './smtp.js';

export type SendersDeps = { verify?: SmtpVerifier; resolver?: Resolver; send?: SendFn };

export function sendersRouter(opts: SendersDeps = {}) {
  const router = Router();
  router.use(requireAuth);

  const deps: AccountDeps = { prisma, verify: opts.verify ?? verifySmtp, resolver: opts.resolver, send: opts.send ?? sendViaSmtp };

  // Read-only view of the worker's counters (same keys, same window maths).
  const limiter = new RateLimiter(redis, {
    prefix: '',
    windowMs: env.RATE_WINDOW_SECONDS * 1000,
    minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
    dayMs: env.WARMUP_DAY_SECONDS * 1000,
  });

  const activeSender = async (id: string) => {
    const s = await prisma.sender.findFirst({ where: { id, isActive: true } });
    if (!s) throw AppError.notFound('Sender not found');
    return s;
  };

  // GET /api/senders — active senders with their effective limit and usage in the current window.
  router.get('/', async (_req, res, next) => {
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

  // GET /api/senders/health — everything the Email Accounts page shows for every active account.
  router.get('/health', async (_req, res, next) => {
    try {
      res.json(await senderDetails(prisma, limiter, { perSenderDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER }));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders — connect an account (logs in to the SMTP server first). Admin-only: senders are shared.
  router.post('/', requireAdmin, async (req, res, next) => {
    try {
      const s = await createAccount(SenderCreateSchema.parse(req.body), deps);
      res.status(201).json({ id: s.id, email: s.email });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/import { rows, verify } — bulk connect from mapped CSV rows; reports every row.
  router.post('/import', requireAdmin, async (req, res, next) => {
    try {
      const { rows, verify } = ImportRequestSchema.parse(req.body);
      res.json(await importAccounts(rows, verify, deps));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/bulk { action, ids, … }
  router.post('/bulk', requireAdmin, async (req, res, next) => {
    try {
      res.json(await bulkAction(BulkActionSchema.parse(req.body), prisma));
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/senders/:id/settings — per-account limits, signature, reply-to, tags.
  router.put('/:id/settings', requireAdmin, async (req, res, next) => {
    try {
      const s = await activeSender(req.params.id!);
      await prisma.sender.update({ where: { id: s.id }, data: settingsData(SenderSettingsSchema.parse(req.body), s) });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/:id/test { to } — log in and send one real message.
  router.post('/:id/test', requireAdmin, async (req, res, next) => {
    try {
      const s = await activeSender(req.params.id!);
      res.json(await testAccount(s, TestEmailSchema.parse(req.body).to, deps));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/:id/dns-check — SPF / DKIM / DMARC / MX for the account's domain.
  router.post('/:id/dns-check', requireAdmin, async (req, res, next) => {
    try {
      res.json(await runDnsCheck(await activeSender(req.params.id!), deps));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/:id/reconnect { smtpPass, … } — new credentials for a disconnected account.
  router.post('/:id/reconnect', requireAdmin, async (req, res, next) => {
    try {
      await reconnectAccount(await activeSender(req.params.id!), ReconnectSchema.parse(req.body), deps);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/:id/acknowledge — clear the error/pause after fixing things at the provider.
  router.post('/:id/acknowledge', requireAdmin, async (req, res, next) => {
    try {
      await acknowledgeError((await activeSender(req.params.id!)).id, prisma);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // POST /api/senders/:id/resume — lift a circuit-breaker pause now.
  router.post('/:id/resume', requireAdmin, async (req, res, next) => {
    try {
      await activeSender(req.params.id!);
      await prisma.sender.update({ where: { id: req.params.id }, data: { pausedUntil: null, pauseReason: null, consecutiveFailures: 0 } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/senders/:id/warmup { enabled, settings?, restart? }
  router.put('/:id/warmup', requireAdmin, async (req, res, next) => {
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

  return router;
}
