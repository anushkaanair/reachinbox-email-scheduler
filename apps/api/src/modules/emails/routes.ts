import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import {
  ListEmailsQuerySchema,
  SearchQuerySchema,
  type SearchResponse,
  TAB_STATUSES,
  type EmailCounts,
  type EmailDetail,
  type EmailEvent,
  type EmailRow,
  type ListEmailsResponse,
} from '@ri/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { cancelEmail, retryEmail, type ControlDeps } from '../campaigns/controls.js';
import type { EmailSearch } from '../search/emailSearch.js';

const router = Router();
router.use(requireAuth);

const rowSelect = {
  id: true,
  campaignId: true,
  toEmail: true,
  toName: true,
  subject: true,
  status: true,
  scheduledAt: true,
  nextAttemptAt: true,
  sentAt: true,
  failedAt: true,
  lastError: true,
  previewUrl: true,
  sender: { select: { email: true } },
  campaign: { select: { status: true } },
} satisfies Prisma.EmailSelect;

type RowRecord = Prisma.EmailGetPayload<{ select: typeof rowSelect }>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toRow = (e: RowRecord): EmailRow => ({
  id: e.id,
  campaignId: e.campaignId,
  campaignStatus: e.campaign.status,
  toEmail: e.toEmail,
  toName: e.toName,
  subject: e.subject,
  status: e.status,
  senderEmail: e.sender.email,
  scheduledAt: e.scheduledAt.toISOString(),
  nextAttemptAt: e.nextAttemptAt.toISOString(),
  sentAt: iso(e.sentAt),
  failedAt: iso(e.failedAt),
  lastError: e.lastError,
  previewUrl: e.previewUrl,
});

// GET /api/emails?status=scheduled|sent&cursor=&limit= — tenant-scoped, cursor-paginated.
router.get('/', async (req, res, next) => {
  try {
    const q = ListEmailsQuerySchema.parse(req.query);
    const orderBy: Prisma.EmailOrderByWithRelationInput[] =
      q.status === 'scheduled'
        ? [{ nextAttemptAt: 'asc' }, { sequence: 'asc' }, { id: 'asc' }]
        : [{ updatedAt: 'desc' }, { id: 'desc' }];

    const rows = await prisma.email.findMany({
      where: { userId: authedUserId(req), status: { in: [...TAB_STATUSES[q.status]] } },
      orderBy,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: rowSelect,
    });

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const body: ListEmailsResponse = {
      items: page.map(toRow),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /api/emails/:id — detail (tenant-scoped: another user's id is a 404, not a 403).
router.get('/:id([0-9a-fA-F-]{36})', async (req, res, next) => {
  try {
    const e = await prisma.email.findFirst({
      where: { id: req.params.id, userId: authedUserId(req) },
      select: {
        ...rowSelect,
        body: true,
        messageId: true,
        attempts: true,
        rateLimitedCount: true,
        dispatchedAt: true,
        createdAt: true,
        events: { orderBy: { at: 'asc' }, select: { type: true, at: true, meta: true } },
      },
    });
    if (!e) throw AppError.notFound('Email not found');
    // Emails from before the event log existed get their history synthesised from timestamps;
    // if only part of it was logged (e.g. retried later), the missing start is filled in.
    const logged: EmailEvent[] = e.events.map((ev) => ({
      type: ev.type,
      at: ev.at.toISOString(),
      meta: (ev.meta as Record<string, unknown>) ?? null,
    }));
    const events: EmailEvent[] = logged.length
      ? logged[0]!.type === 'SCHEDULED'
        ? logged
        : [{ type: 'SCHEDULED', at: e.createdAt.toISOString(), meta: null }, ...logged]
      : [
          { type: 'SCHEDULED', at: e.createdAt.toISOString(), meta: null },
          ...(e.sentAt ? [{ type: 'SENT' as const, at: e.sentAt.toISOString(), meta: null }] : []),
          ...(e.failedAt ? [{ type: 'FAILED' as const, at: e.failedAt.toISOString(), meta: { error: e.lastError } }] : []),
        ];
    const body: EmailDetail = {
      ...toRow(e),
      body: e.body,
      messageId: e.messageId,
      attempts: e.attempts,
      rateLimitedCount: e.rateLimitedCount,
      dispatchedAt: iso(e.dispatchedAt),
      createdAt: e.createdAt.toISOString(),
      events,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /api/emails/counts — sidebar badges.
router.get('/counts', async (req, res, next) => {
  try {
    const grouped = await prisma.email.groupBy({
      by: ['status'],
      where: { userId: authedUserId(req) },
      _count: { _all: true },
    });
    const n = (statuses: readonly string[]) =>
      grouped.filter((g) => statuses.includes(g.status)).reduce((s, g) => s + g._count._all, 0);
    const body: EmailCounts = {
      scheduled: n(TAB_STATUSES.scheduled),
      sent: n(['SENT']),
      failed: n(['FAILED']),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/emails/search?q=&status=&page= — Elasticsearch finds and ranks (with highlights);
 * rows are then read from Postgres so status/times are always current (the index is eventually
 * consistent). Order follows ES relevance.
 */
export function emailsRouter(search: EmailSearch, controls: ControlDeps) {
  const r = Router();
  // POST /api/emails/:id/retry | /cancel — per-email actions (features F6 / F3).
  r.post('/:id([0-9a-fA-F-]{36})/:action(retry|cancel)', requireAuth, async (req, res, next) => {
    try {
      const act = req.params.action === 'retry' ? retryEmail : cancelEmail;
      await act(authedUserId(req), req.params.id!, controls);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
  r.get('/search', requireAuth, async (req, res, next) => {
    try {
      const userId = authedUserId(req);
      const q = SearchQuerySchema.parse(req.query);
      const found = await search.search(userId, q).catch((err) => {
        throw new AppError(503, 'UNAVAILABLE', 'Search is temporarily unavailable', env.isProd ? undefined : String(err?.message ?? err));
      });
      const rows = await prisma.email.findMany({ where: { id: { in: found.ids }, userId }, select: rowSelect });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const body: SearchResponse = {
        items: found.ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [{ ...toRow(row), highlights: found.highlights[id] ?? {} }] : [];
        }),
        total: found.total,
        tookMs: found.tookMs,
        approximate: found.approximate,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
  r.use(router);
  return r;
}
