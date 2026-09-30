import { Router } from 'express';
import { WebhookCreateSchema, WebhookUpdateSchema } from '@ri/shared';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, rotateSecret, testWebhook, updateWebhook } from './service.js';

export function webhooksRouter(opts: { allowPrivate?: boolean } = {}) {
  const r = Router();
  r.use(requireAuth);
  const deps = { prisma, allowPrivate: opts.allowPrivate ?? env.ALLOW_PRIVATE_WEBHOOK_HOSTS };

  r.get('/', async (req, res, next) => {
    try {
      res.json(await listWebhooks(prisma, authedUserId(req)));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/webhooks { url, events, campaignId? } → the webhook plus its signing secret, shown this once
  r.post('/', async (req, res, next) => {
    try {
      res.status(201).json(await createWebhook(deps, authedUserId(req), WebhookCreateSchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id', async (req, res, next) => {
    try {
      res.json(await updateWebhook(deps, authedUserId(req), req.params.id!, WebhookUpdateSchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/rotate-secret', async (req, res, next) => {
    try {
      res.json(await rotateSecret(deps, authedUserId(req), req.params.id!));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/test', async (req, res, next) => {
    try {
      res.json(await testWebhook(deps, authedUserId(req), req.params.id!));
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id/deliveries', async (req, res, next) => {
    try {
      res.json(await listDeliveries(prisma, authedUserId(req), req.params.id!));
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      await deleteWebhook(prisma, authedUserId(req), req.params.id!);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}
