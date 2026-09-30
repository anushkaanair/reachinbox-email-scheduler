import { DelayedError, type Job } from 'bullmq';
import type { EmailEventType, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { SendFn } from '../mail/transport.js';
import type { RateLimiter, Ticket } from '../throttle/rateLimiter.js';
import { isInSendWindow, nextSendWindowStart, SendWindowSchema } from '@ri/shared';
import { windowEnd, windowStart } from '../throttle/windows.js';
import type { EmailJobData, RateLimitNotice } from './queues.js';

export type ProcessorConfig = {
  maxPerWindowGlobal: number;
  maxPerWindowPerSender: number;
  staleSendingMs: number;
};

export type ProcessorDeps = {
  prisma: PrismaClient;
  limiter: RateLimiter;
  send: SendFn;
  logger: Logger;
  config: ProcessorConfig;
  /** Called once per scope+window when a limit is first hit (→ Slack in Phase 3). */
  onRateLimited: (notice: RateLimitNotice) => Promise<void>;
  /** Called after every status change (→ search re-index + live push). Failures never affect sending. */
  onEmailChanged?: (emailId: string, change: EmailChange) => Promise<void>;
};

export type EmailChange = { userId: string; campaignId: string; status: string };

export type ProcessResult = { outcome: 'sent' | 'skipped'; reason?: string };

/** Sends a little early rather than re-delaying for a few ms of timer jitter. */
const EARLY_TOLERANCE_MS = 25;
const CLAIMABLE = ['SCHEDULED', 'RATE_LIMITED'] as const;

/**
 * The send pipeline (GODFATHER §5.2). Every step is idempotent and safe under concurrency:
 *   load → skip terminal → throttle (slot + quota, atomic in Redis) → claim row
 *   (conditional UPDATE, one winner) → SMTP → mark SENT.
 * Delays use moveToDelayed + DelayedError, which does not consume a retry attempt.
 */
export function createEmailProcessor(deps: ProcessorDeps) {
  const { prisma, limiter, send, logger, config } = deps;

  /** Records history (timeline/analytics) and notifies listeners. Never breaks the send path. */
  const changed = async (
    e: { id: string; userId: string; campaignId: string },
    status: string,
    type: EmailEventType,
    meta?: Prisma.InputJsonValue,
  ) => {
    try {
      await prisma.emailEvent.create({ data: { emailId: e.id, userId: e.userId, type, meta } });
      await deps.onEmailChanged?.(e.id, { userId: e.userId, campaignId: e.campaignId, status });
    } catch (err) {
      logger.warn({ err, emailId: e.id }, 'recording email change failed');
    }
  };

  const delay = async (job: Job<EmailJobData>, token: string | undefined, until: number) => {
    await job.moveToDelayed(until, token);
    throw new DelayedError();
  };

  return async function processEmail(job: Job<EmailJobData>, token?: string): Promise<ProcessResult> {
    const { emailId } = job.data;
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { sender: true, campaign: { select: { status: true, hourlyLimit: true, userId: true, sendWindow: true } } },
    });
    const log = logger.child({ emailId, jobId: job.id });

    if (!email) return { outcome: 'skipped', reason: 'missing' };
    if (email.status === 'SENT' || email.status === 'FAILED' || email.status === 'CANCELLED') {
      return { outcome: 'skipped', reason: `already_${email.status.toLowerCase()}` };
    }
    if (email.campaign.status === 'CANCELLED') return { outcome: 'skipped', reason: 'campaign_cancelled' };
    // Paused campaigns keep their rows; resume re-enqueues them (see campaigns/controls.ts).
    if (email.campaign.status === 'PAUSED') return { outcome: 'skipped', reason: 'campaign_paused' };

    // Another worker holds it, or a worker died mid-send. Never resend blindly (at-most-once):
    // re-check once the lock is stale, then give up with a clear reason.
    if (email.status === 'SENDING') {
      const staleAt = (email.lockedAt?.getTime() ?? 0) + config.staleSendingMs;
      if (Date.now() < staleAt) return delay(job, token, staleAt);
      await prisma.email.updateMany({
        where: { id: emailId, status: 'SENDING' },
        data: { status: 'FAILED', failedAt: new Date(), lockedAt: null, lastError: 'interrupted_before_confirmation' },
      });
      log.warn('stale SENDING row marked FAILED (not re-sent to avoid a duplicate)');
      await changed(email, 'FAILED', 'FAILED', { error: 'interrupted_before_confirmation', final: true });
      return { outcome: 'skipped', reason: 'stale_sending' };
    }

    const now = Date.now();

    // Business hours: a deferred or retried email must not go out at 3 AM. Wait for the next opening
    // *before* touching the throttle, so no quota or slot is held meanwhile.
    const hours = SendWindowSchema.safeParse(email.campaign.sendWindow);
    if (hours.success && !isInSendWindow(now, hours.data)) {
      const opens = nextSendWindowStart(now, hours.data);
      await prisma.email.updateMany({ where: { id: emailId, status: { in: [...CLAIMABLE] } }, data: { nextAttemptAt: new Date(opens) } });
      log.info({ opens: new Date(opens).toISOString() }, 'outside business hours, waiting');
      return delay(job, token, opens);
    }

    const limits = {
      global: config.maxPerWindowGlobal,
      sender: email.sender.hourlyLimit ?? config.maxPerWindowPerSender,
      campaign: email.campaign.hourlyLimit,
    };

    // A ticket reserved earlier is only valid inside the window it was counted in.
    let ticket: Ticket | undefined = job.data.ticket;
    if (ticket && now >= windowEnd(ticket.w, limiter.opts.windowMs)) {
      // Unused reservation from a window that has passed (e.g. worker was down): give it back.
      await limiter.refund(ticket, email.senderId, email.campaignId);
      ticket = undefined;
    }

    if (!ticket) {
      const res = await limiter.acquire({ now, senderId: email.senderId, campaignId: email.campaignId, limits });
      if (!res.ok) {
        await prisma.email.updateMany({
          where: { id: emailId, status: { in: [...CLAIMABLE] } },
          data: { status: 'RATE_LIMITED', nextAttemptAt: new Date(res.retryAt), rateLimitedCount: { increment: 1 } },
        });
        await changed(email, 'RATE_LIMITED', 'RATE_LIMITED', {
          scope: res.scope,
          limit: limits[res.scope],
          retryAt: new Date(res.retryAt).toISOString(),
        });
        const scopeId = res.scope === 'global' ? 'all' : res.scope === 'sender' ? email.senderId : email.campaignId;
        if (await limiter.firstHitInWindow(res.scope, scopeId, res.w)) {
          log.info({ scope: res.scope, retryAt: new Date(res.retryAt).toISOString() }, 'rate limit reached');
          await deps
            .onRateLimited({
              userId: email.campaign.userId,
              senderId: email.senderId,
              senderEmail: email.sender.email,
              scope: res.scope,
              limit: limits[res.scope],
              windowStart: new Date(windowStart(res.w, limiter.opts.windowMs)).toISOString(),
              retryAt: new Date(res.retryAt).toISOString(),
            })
            .catch((err) => log.error({ err }, 'rate-limit notification failed (send path unaffected)'));
        }
        await job.updateData({ emailId });
        return delay(job, token, res.retryAt);
      }
      ticket = res.ticket;
      await job.updateData({ emailId, ticket }); // persisted in Redis → survives restarts
    }

    if (ticket.slot > now + EARLY_TOLERANCE_MS) {
      await prisma.email.updateMany({
        where: { id: emailId, status: { in: [...CLAIMABLE] } },
        data: { status: 'SCHEDULED', nextAttemptAt: new Date(ticket.slot) },
      });
      return delay(job, token, ticket.slot);
    }

    // Strict min-delay at the real dispatch instant (the reserved ticket is kept while waiting).
    const dispatchAt = Date.now();
    const notBefore = await limiter.gate(email.senderId, dispatchAt);
    if (notBefore > 0) return delay(job, token, notBefore);

    // DB-level idempotency: exactly one worker can move the row out of a claimable state.
    const claimed = await prisma.email.updateMany({
      where: { id: emailId, status: { in: [...CLAIMABLE] } },
      data: { status: 'SENDING', lockedAt: new Date(dispatchAt), dispatchedAt: new Date(dispatchAt), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      await limiter.refund(ticket, email.senderId, email.campaignId);
      return { outcome: 'skipped', reason: 'claimed_elsewhere' };
    }

    try {
      const result = await send(email.sender, {
        emailId,
        to: email.toEmail,
        toName: email.toName,
        subject: email.subject,
        body: email.body,
      });
      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          messageId: result.messageId,
          previewUrl: result.previewUrl,
          lockedAt: null,
          lastError: null,
        },
      });
      log.info({ to: email.toEmail, sender: email.sender.email }, 'email sent');
      await changed(email, 'SENT', 'SENT', { sender: email.sender.email, previewUrl: result.previewUrl });
      return { outcome: 'sent' };
    } catch (err) {
      await limiter.refund(ticket, email.senderId, email.campaignId);
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const message = err instanceof Error ? err.message : String(err);
      await prisma.email.update({
        where: { id: emailId },
        data: final
          ? { status: 'FAILED', failedAt: new Date(), lockedAt: null, lastError: message }
          : { status: 'SCHEDULED', lockedAt: null, lastError: message },
      });
      await job.updateData({ emailId }); // a retry must re-acquire a fresh slot
      await changed(email, final ? 'FAILED' : 'SCHEDULED', final ? 'FAILED' : 'SEND_ERROR', {
        error: message,
        attempt: job.attemptsMade + 1,
        final,
      });
      log.warn({ err: message, final, attempt: job.attemptsMade + 1 }, 'send failed');
      throw err; // BullMQ applies exponential backoff; FAILED after the last attempt
    }
  };
}
