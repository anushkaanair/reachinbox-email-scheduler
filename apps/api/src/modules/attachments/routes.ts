import express, { Router, type RequestHandler } from 'express';
import { MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES, type Attachment } from '@ri/shared';
import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { checkUpload } from './validate.js';

/** Files uploaded but never attached to a campaign are removed when the owner next uploads: no timer needed. */
const STAGED_TTL_MS = 24 * 3600_000;

const body: RequestHandler = (req, res, next) =>
  express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES })(req, res, (err?: unknown) =>
    err && (err as { type?: string }).type === 'entity.too.large' ? next(new AppError(413, 'VALIDATION', 'That file is larger than 5 MB.')) : next(err),
  );

const toApi = (a: { id: string; fileName: string; contentType: string; size: number }): Attachment => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, size: a.size });

export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);

// POST /api/attachments?name=report.pdf  (raw file bytes) → the staged attachment
attachmentsRouter.post('/', body, async (req, res, next) => {
  try {
    const userId = authedUserId(req);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = checkUpload(typeof req.query.name === 'string' ? req.query.name : '', data);
    if (!check.ok) throw new AppError(422, 'VALIDATION', check.message);

    await prisma.attachment.deleteMany({ where: { userId, campaignId: null, createdAt: { lt: new Date(Date.now() - STAGED_TTL_MS) } } });
    const staged = await prisma.attachment.aggregate({ where: { userId, campaignId: null }, _count: { _all: true }, _sum: { size: true } });
    if (staged._count._all >= MAX_ATTACHMENTS) throw new AppError(409, 'CONFLICT', `You can attach up to ${MAX_ATTACHMENTS} files.`);
    if ((staged._sum.size ?? 0) + data.length > MAX_ATTACHMENTS_TOTAL_BYTES) throw new AppError(409, 'CONFLICT', 'Attachments can total up to 10 MB.');

    const a = await prisma.attachment.create({ data: { userId, fileName: check.fileName, contentType: check.contentType, size: data.length, data: new Uint8Array(data) }, select: { id: true, fileName: true, contentType: true, size: true } });
    res.status(201).json(toApi(a));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/attachments/:id — only files not yet attached to a campaign
attachmentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const done = await prisma.attachment.deleteMany({ where: { id: req.params.id, userId: authedUserId(req), campaignId: null } });
    if (done.count === 0) throw AppError.notFound('Attachment not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /api/attachments/:id/download — the owner's own files, always as a download
attachmentsRouter.get('/:id/download', async (req, res, next) => {
  try {
    const a = await prisma.attachment.findFirst({ where: { id: req.params.id, userId: authedUserId(req) } });
    if (!a) throw AppError.notFound('Attachment not found');
    res.setHeader('Content-Type', a.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${a.fileName.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(a.data));
  } catch (err) {
    next(err);
  }
});
