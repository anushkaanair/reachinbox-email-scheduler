import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  isValidEmail,
  renderTemplate,
  type CreateCampaignInput,
  type CreateCampaignResponse,
} from '@ri/shared';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { publishLive } from '../../lib/live.js';
import { enqueueEmails, enqueueIndex, type QueueSet } from '../../queues/queues.js';

export type SchedulingConfig = {
  maxPerWindowGlobal: number;
  maxPerWindowPerSender: number;
  minDelayMs: number;
  windowMs: number;
};

type CleanLead = { email: string; name?: string; vars: Record<string, string> };

/** Trim, lowercase, validate, dedupe (first occurrence wins). */
export function normalizeLeads(leads: CreateCampaignInput['leads']) {
  const seen = new Set<string>();
  const clean: CleanLead[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const l of leads) {
    const email = l.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      invalid.push(l.email);
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    clean.push({ email, name: l.name?.trim() || undefined, vars: l.vars ?? {} });
  }
  return { clean, invalid, duplicates };
}

/**
 * Rough, honest ETA: bounded by the campaign's own spacing and by how many windows the
 * effective per-window capacity needs. Shown in the composer and returned by the API.
 */
export function estimateFinish(
  n: number,
  startMs: number,
  delayMs: number,
  campaignLimit: number,
  senders: { hourlyLimit: number | null }[],
  cfg: SchedulingConfig,
): Date {
  const senderCapacity = senders.reduce((s, x) => s + (x.hourlyLimit ?? cfg.maxPerWindowPerSender), 0);
  const perWindow = Math.max(1, Math.min(campaignLimit, senderCapacity, cfg.maxPerWindowGlobal));
  const spacing = Math.max(delayMs, cfg.minDelayMs / Math.max(1, senders.length));
  const bySpacing = startMs + (n - 1) * spacing;
  const byWindows = startMs + (Math.ceil(n / perWindow) - 1) * cfg.windowMs;
  return new Date(Math.max(bySpacing, byWindows));
}

/**
 * Schedules a campaign: one DB transaction for campaign + emails, then delayed BullMQ jobs
 * (jobId = email id). If enqueueing fails after commit, the worker's boot reconciler re-adds
 * the missing jobs — Postgres stays the source of truth (outbox-lite).
 */
export async function createCampaign(
  userId: string,
  input: CreateCampaignInput,
  deps: { prisma: PrismaClient; queues: QueueSet; config: SchedulingConfig; redis?: Redis },
): Promise<CreateCampaignResponse> {
  const { prisma, queues, config } = deps;
  const { clean, invalid, duplicates } = normalizeLeads(input.leads);
  if (clean.length === 0) {
    throw new AppError(400, 'VALIDATION', 'No valid email addresses found', { invalid, duplicates });
  }

  const senders = await prisma.sender.findMany({
    where: { isActive: true, ...(input.senderIds?.length ? { id: { in: input.senderIds } } : {}) },
    orderBy: { email: 'asc' },
  });
  if (senders.length === 0) {
    throw new AppError(409, 'CONFLICT', 'No active senders. Run `npm run senders:create -w @ri/api` first.');
  }

  const now = Date.now();
  // A start time slightly in the past (clock drift, slow form) means "now".
  const startMs = Math.max(now, new Date(input.startAt).getTime());
  const delayMs = input.delayBetweenSeconds * 1000;
  const campaignId = randomUUID();

  const rows: Prisma.EmailCreateManyInput[] = clean.map((lead, i) => {
    const at = new Date(startMs + i * delayMs);
    const vars = { email: lead.email, name: lead.name ?? '', ...lead.vars };
    return {
      id: randomUUID(),
      campaignId,
      userId,
      senderId: senders[i % senders.length]!.id, // round-robin across senders
      toEmail: lead.email,
      toName: lead.name ?? null,
      vars: lead.vars,
      subject: renderTemplate(input.subject, vars),
      body: renderTemplate(input.body, vars),
      sequence: i,
      scheduledAt: at,
      nextAttemptAt: at,
    };
  });

  await prisma.$transaction(async (tx) => {
    await tx.campaign.create({
      data: {
        id: campaignId,
        userId,
        subject: input.subject,
        body: input.body,
        startAt: new Date(startMs),
        delayBetweenMs: delayMs,
        hourlyLimit: input.hourlyLimit,
        totalRecipients: rows.length,
      },
    });
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await tx.email.createMany({ data: chunk });
      await tx.emailEvent.createMany({
        data: chunk.map((r) => ({ emailId: r.id!, userId, type: 'SCHEDULED' as const, meta: { at: (r.scheduledAt as Date).toISOString() } })),
      });
    }
  });

  await enqueueEmails(
    queues.email,
    rows.map((r) => ({ id: r.id!, nextAttemptAt: r.nextAttemptAt as Date })),
  );
  await enqueueIndex(
    queues.index,
    rows.map((r) => r.id!),
  );
  if (deps.redis) await publishLive(deps.redis, userId, { type: 'campaign.updated', campaignId, status: 'ACTIVE' });

  return {
    campaignId,
    accepted: rows.length,
    invalid,
    duplicates,
    estimatedFinishAt: estimateFinish(rows.length, startMs, delayMs, input.hourlyLimit, senders, config).toISOString(),
  };
}
