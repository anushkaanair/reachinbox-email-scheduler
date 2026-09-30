import { Router } from 'express';
import { z } from 'zod';
import { AddSuppressionsInputSchema, isValidEmail, type AddSuppressionsResponse, type SuppressionList } from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';

const ListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The user's do-not-contact list: leads on it are skipped when a campaign is created. */
export const suppressionsRouter = Router();
suppressionsRouter.use(requireAuth);

suppressionsRouter.get('/', async (req, res, next) => {
  try {
    const userId = authedUserId(req);
    const { q, limit } = ListQuerySchema.parse(req.query);
    const where = { userId, ...(q ? { email: { contains: q.toLowerCase() } } : {}) };
    const [items, total] = await Promise.all([
      prisma.suppressedEmail.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
      prisma.suppressedEmail.count({ where }),
    ]);
    const body: SuppressionList = {
      items: items.map((s) => ({ id: s.id, email: s.email, createdAt: s.createdAt.toISOString() })),
      total,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

suppressionsRouter.post('/', async (req, res, next) => {
  try {
    const userId = authedUserId(req);
    const { emails } = AddSuppressionsInputSchema.parse(req.body);
    const valid = new Set<string>();
    const invalid: string[] = [];
    for (const raw of emails) {
      const e = raw.trim().toLowerCase();
      if (!e) continue;
      if (isValidEmail(e)) valid.add(e);
      else invalid.push(raw.trim());
    }
    const created = await prisma.suppressedEmail.createMany({
      data: [...valid].map((email) => ({ userId, email })),
      skipDuplicates: true,
    });
    const body: AddSuppressionsResponse = { added: created.count, alreadyListed: valid.size - created.count, invalid };
    res.status(created.count > 0 ? 201 : 200).json(body);
  } catch (err) {
    next(err);
  }
});

suppressionsRouter.delete('/:id', async (req, res, next) => {
  try {
    const removed = await prisma.suppressedEmail.deleteMany({ where: { id: req.params.id, userId: authedUserId(req) } });
    if (removed.count === 0) throw AppError.notFound('Entry not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
