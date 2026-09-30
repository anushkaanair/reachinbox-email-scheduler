import { Router } from 'express';
import { z } from 'zod';
import { CreateLeadListSchema, LEAD_REASON_LABEL, LEAD_STATUS_LABEL, LeadStatusSchema } from '@ri/shared';
import { csvRow } from '../../lib/csv.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import type { MailResolver } from './dns.js';
import { createList, leadPage, listLists, ownList, recipients, removeByStatus, summaryOf, verifyList } from './service.js';

const PageQuery = z.object({ status: z.string().max(20).optional(), cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

export function leadListsRouter(deps: { resolver?: MailResolver } = {}) {
  const r = Router();
  r.use(requireAuth);

  r.get('/', async (req, res, next) => {
    try {
      res.json(await listLists(prisma, authedUserId(req)));
    } catch (err) {
      next(err);
    }
  });

  r.post('/', async (req, res, next) => {
    try {
      res.status(201).json(await createList(prisma, authedUserId(req), CreateLeadListSchema.parse(req.body)));
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', async (req, res, next) => {
    try {
      res.json(await summaryOf(prisma, authedUserId(req), req.params.id!));
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id/leads', async (req, res, next) => {
    try {
      res.json(await leadPage(prisma, authedUserId(req), req.params.id!, PageQuery.parse(req.query)));
    } catch (err) {
      next(err);
    }
  });

  // POST /api/lead-lists/:id/verify — checks the addresses not yet checked; call again until `remaining` is 0
  r.post('/:id/verify', async (req, res, next) => {
    try {
      res.json(await verifyList(prisma, authedUserId(req), req.params.id!, { resolver: deps.resolver }));
    } catch (err) {
      next(err);
    }
  });

  // GET /api/lead-lists/:id/recipients?includeUndeliverable=true — the leads, ready for Compose
  r.get('/:id/recipients', async (req, res, next) => {
    try {
      res.json(await recipients(prisma, authedUserId(req), req.params.id!, { includeUndeliverable: req.query.includeUndeliverable === 'true' }));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/lead-lists/:id/leads?status=UNDELIVERABLE — drop everything with that verdict
  r.delete('/:id/leads', async (req, res, next) => {
    try {
      const status = LeadStatusSchema.safeParse(req.query.status);
      if (!status.success) throw new AppError(400, 'VALIDATION', 'Choose which leads to remove (status=VALID|RISKY|UNDELIVERABLE|UNKNOWN)');
      res.json({ removed: await removeByStatus(prisma, authedUserId(req), req.params.id!, status.data) });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', async (req, res, next) => {
    try {
      const done = await prisma.leadList.deleteMany({ where: { id: req.params.id, userId: authedUserId(req) } });
      if (done.count === 0) throw AppError.notFound('List not found');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/lead-lists/:id/export?status= — streamed CSV, formula-injection safe
  r.get('/:id/export', async (req, res, next) => {
    try {
      const userId = authedUserId(req);
      const list = await ownList(prisma, userId, req.params.id!);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${list.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'list'}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.write('﻿');
      res.write(csvRow(['email', 'name', 'status', 'reason', 'suggestion', 'checked_at']));
      let cursor: string | undefined;
      for (;;) {
        const page = await leadPage(prisma, userId, list.id, { status, cursor, limit: 200 });
        for (const l of page.items) res.write(csvRow([l.email, l.name, l.status ? LEAD_STATUS_LABEL[l.status] : 'Not checked', l.reason ? LEAD_REASON_LABEL[l.reason] : '', l.suggestion, l.checkedAt]));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      res.end();
    } catch (err) {
      if (res.headersSent) res.end();
      else next(err);
    }
  });

  return r;
}
