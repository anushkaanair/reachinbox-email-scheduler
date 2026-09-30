import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DraftPayloadSchema, draftTitle, MAX_DRAFTS, type Draft, type DraftSummary } from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';

export const draftsRouter = Router();
draftsRouter.use(requireAuth);

const leadCount = (payload: unknown) => DraftPayloadSchema.safeParse(payload).data?.leads.length ?? 0;
const summary = (d: { id: string; title: string; payload: unknown; updatedAt: Date }): DraftSummary => ({ id: d.id, title: d.title, recipients: leadCount(d.payload), updatedAt: d.updatedAt.toISOString() });

// GET /api/drafts — newest first. Payloads stay on the server until one is opened.
draftsRouter.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.draft.findMany({ where: { userId: authedUserId(req) }, orderBy: { updatedAt: 'desc' }, select: { id: true, title: true, payload: true, updatedAt: true } });
    res.json(rows.map(summary));
  } catch (err) {
    next(err);
  }
});

// GET /api/drafts/:id
draftsRouter.get('/:id', async (req, res, next) => {
  try {
    const d = await prisma.draft.findFirst({ where: { id: req.params.id, userId: authedUserId(req) } });
    if (!d) throw AppError.notFound('Draft not found');
    const payload = DraftPayloadSchema.parse(d.payload);
    const body: Draft = { ...summary(d), payload };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /api/drafts { …payload } → create; PUT /api/drafts/:id → update
draftsRouter.post('/', async (req, res, next) => {
  try {
    const userId = authedUserId(req);
    const payload = DraftPayloadSchema.parse(req.body);
    if ((await prisma.draft.count({ where: { userId } })) >= MAX_DRAFTS) throw new AppError(409, 'CONFLICT', `You can keep up to ${MAX_DRAFTS} drafts. Delete one first.`);
    const d = await prisma.draft.create({ data: { userId, title: draftTitle(payload), payload: payload as unknown as Prisma.InputJsonValue } });
    res.status(201).json(summary(d));
  } catch (err) {
    next(err);
  }
});

draftsRouter.put('/:id', async (req, res, next) => {
  try {
    const payload = DraftPayloadSchema.parse(req.body);
    const done = await prisma.draft.updateMany({ where: { id: req.params.id, userId: authedUserId(req) }, data: { title: draftTitle(payload), payload: payload as unknown as Prisma.InputJsonValue } });
    if (done.count === 0) throw AppError.notFound('Draft not found');
    const d = await prisma.draft.findUniqueOrThrow({ where: { id: req.params.id } });
    res.json(summary(d));
  } catch (err) {
    next(err);
  }
});

draftsRouter.delete('/:id', async (req, res, next) => {
  try {
    const done = await prisma.draft.deleteMany({ where: { id: req.params.id, userId: authedUserId(req) } });
    if (done.count === 0) throw AppError.notFound('Draft not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
