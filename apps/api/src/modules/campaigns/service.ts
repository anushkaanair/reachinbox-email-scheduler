import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_BOUNCE_PROTECTION,
  escapeHtml,
  htmlToText,
  isHtmlEmpty,
  isValidEmail,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  makePreview,
  renderTemplate,
  spin,
  type BounceProtection,
  type SendWindow,
  type CreateCampaignInput,
  type CreateCampaignResponse,
} from '@ri/shared';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';
import { publishLive } from '../../lib/live.js';
import { sanitizeBody } from '../../lib/sanitizeHtml.js';
import { enqueueEmails, enqueueIndex, type QueueSet } from '../../queues/queues.js';
import type { RateLimiter } from '../../throttle/rateLimiter.js';
import { applyGuards, forecast, jitterSeed, scheduleTimes, type Forecast } from './planning.js';

export type SchedulingConfig = {
  maxPerWindowGlobal: number;
  maxPerWindowPerSender: number;
  minDelayMs: number;
  windowMs: number;
};

/** Same as the validated API input, but callers (tests, scripts) may omit the defaulted fields. */
export type CampaignInput = Omit<CreateCampaignInput, 'skipRecentDays' | 'jitterPercent' | 'bounceProtection' | 'bodyFormat' | 'attachmentIds'> & {
  bodyFormat?: 'TEXT' | 'HTML';
  attachmentIds?: string[];
  skipRecentDays?: number;
  jitterPercent?: number;
  bounceProtection?: Partial<BounceProtection>;
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

/** Active senders (optionally a subset), ordered so round-robin assignment is stable. */
export async function loadSenders(prisma: PrismaClient, senderIds?: string[]) {
  return prisma.sender.findMany({
    where: { isActive: true, ...(senderIds?.length ? { id: { in: senderIds } } : {}) },
    orderBy: { email: 'asc' },
  });
}

/** Forecast from the same numbers the limiter uses, including what senders already used this window. */
export async function computeForecast(opts: {
  times: number[];
  senders: { id: string; hourlyLimit: number | null }[];
  campaignLimit: number;
  sendWindow?: SendWindow | null;
  config: SchedulingConfig;
  limiter?: RateLimiter;
}): Promise<Forecast> {
  const senders = await Promise.all(
    opts.senders.map(async (s) => ({
      limit: s.hourlyLimit ?? opts.config.maxPerWindowPerSender,
      used: opts.limiter ? await opts.limiter.senderUsage(s.id) : 0,
    })),
  );
  return forecast({
    times: opts.times,
    nowMs: Date.now(),
    windowMs: opts.config.windowMs,
    minDelayMs: opts.config.minDelayMs,
    campaignLimit: opts.campaignLimit,
    globalLimit: opts.config.maxPerWindowGlobal,
    senders,
    sendWindow: opts.sendWindow,
  });
}

/**
 * Schedules a campaign: one DB transaction for campaign + emails, then delayed BullMQ jobs
 * (jobId = email id). If enqueueing fails after commit, the worker's boot reconciler re-adds
 * the missing jobs — Postgres stays the source of truth (outbox-lite).
 */
export async function createCampaign(
  userId: string,
  input: CampaignInput,
  deps: { prisma: PrismaClient; queues: QueueSet; config: SchedulingConfig; redis?: Redis; limiter?: RateLimiter },
): Promise<CreateCampaignResponse> {
  const { prisma, queues, config } = deps;
  const isHtml = input.bodyFormat === 'HTML';
  // Never trust the browser's HTML: re-sanitise with the allowlist, and refuse a body with nothing in it.
  const bodyTemplate = isHtml ? sanitizeBody(input.body) : input.body;
  if (isHtml && isHtmlEmpty(bodyTemplate)) throw new AppError(400, 'VALIDATION', 'Body is required', { fieldErrors: { body: ['Body is required'] } });
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length) {
    // Only the owner's own staged files can go out, and never more than the campaign limit in total.
    const staged = await prisma.attachment.findMany({ where: { id: { in: attachmentIds }, userId, campaignId: null }, select: { size: true } });
    if (staged.length !== attachmentIds.length) throw new AppError(400, 'VALIDATION', 'One of the attachments is no longer available. Add it again.');
    if (staged.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) throw new AppError(400, 'VALIDATION', 'Attachments can total up to 10 MB.');
  }
  const normalized = normalizeLeads(input.leads);
  const { invalid, duplicates } = normalized;
  if (normalized.clean.length === 0) {
    throw new AppError(400, 'VALIDATION', 'No valid email addresses found', { invalid, duplicates });
  }

  // Never email the do-not-contact list, or (optionally) anyone contacted recently.
  const guarded = await applyGuards(prisma, userId, normalized.clean, input.skipRecentDays ?? 0);
  const clean = guarded.sendable;
  if (clean.length === 0) {
    throw new AppError(400, 'VALIDATION', 'Every lead was skipped (do-not-contact list or recently emailed)', {
      suppressed: guarded.suppressed.length,
      recentlyEmailed: guarded.recentlyEmailed.length,
    });
  }

  const senders = await loadSenders(prisma, input.senderIds);
  if (senders.length === 0) {
    throw new AppError(409, 'CONFLICT', 'No active senders. Run `npm run senders:create -w @ri/api` first.');
  }

  const now = Date.now();
  // A start time slightly in the past (clock drift, slow form) means "now".
  const startMs = Math.max(now, new Date(input.startAt).getTime());
  const delayMs = input.delayBetweenSeconds * 1000;
  const campaignId = randomUUID();

  const sendWindow = input.sendWindow ?? null;
  const jitterPercent = input.jitterPercent ?? 0;
  const times = scheduleTimes(clean.length, startMs, delayMs, sendWindow, jitterPercent, jitterSeed(clean.map((l) => l.email)));

  const rows: Prisma.EmailCreateManyInput[] = clean.map((lead, i) => {
    const at = new Date(times[i]!);
    const vars = { email: lead.email, name: lead.name ?? '', ...lead.vars };
    return {
      id: randomUUID(),
      campaignId,
      userId,
      senderId: senders[i % senders.length]!.id, // round-robin across senders
      toEmail: lead.email,
      toName: lead.name ?? null,
      vars: lead.vars,
      // Spintax first (one variant per recipient, seeded by their address), then merge tags.
      subject: renderTemplate(spin(input.subject, lead.email), vars),
      // Merge values are escaped in HTML bodies so a lead's data can never inject markup.
      body: renderTemplate(spin(bodyTemplate, lead.email), vars, isHtml ? escapeHtml : undefined),
      bodyIsHtml: isHtml,
      preview: makePreview(isHtml ? htmlToText(renderTemplate(spin(bodyTemplate, lead.email), vars, escapeHtml)) : renderTemplate(spin(bodyTemplate, lead.email), vars)),
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
        body: bodyTemplate,
        bodyFormat: isHtml ? 'HTML' : 'TEXT',
        startAt: new Date(times[0]!),
        delayBetweenMs: delayMs,
        sendWindow: sendWindow ?? undefined,
        skipRecentDays: input.skipRecentDays ?? 0,
        jitterPercent,
        bounceThresholdPercent: input.bounceProtection?.thresholdPercent ?? DEFAULT_BOUNCE_PROTECTION.thresholdPercent,
        bounceMinSends: input.bounceProtection?.minSends ?? DEFAULT_BOUNCE_PROTECTION.minSends,
        hourlyLimit: input.hourlyLimit,
        totalRecipients: rows.length,
      },
    });
    if (attachmentIds.length) {
      const linked = await tx.attachment.updateMany({ where: { id: { in: attachmentIds }, userId, campaignId: null }, data: { campaignId } });
      if (linked.count !== attachmentIds.length) throw new AppError(409, 'CONFLICT', 'An attachment changed while scheduling. Try again.'); // rolls the whole campaign back
    }
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

  const fc = await computeForecast({ times, senders, campaignLimit: input.hourlyLimit, sendWindow, config, limiter: deps.limiter });
  return {
    campaignId,
    accepted: rows.length,
    invalid,
    duplicates,
    suppressed: guarded.suppressed.length,
    recentlyEmailed: guarded.recentlyEmailed.length,
    firstSendAt: new Date(times[0]!).toISOString(),
    // If the run is longer than we simulate, fall back to the last scheduled time.
    estimatedFinishAt: fc.finishAt ?? new Date(times[times.length - 1]!).toISOString(),
  };
}
