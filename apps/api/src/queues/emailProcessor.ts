import { DelayedError, type Job } from 'bullmq';
import type { EmailEventType, Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { createAttachmentLoader, type AttachmentLoader } from '../mail/attachments.js';
import type { SendFn } from '../mail/transport.js';
import type { RateLimiter, Ticket } from '../throttle/rateLimiter.js';
import { bounceVerdict, isAuthError, isHardBounce, isInSendWindow, nextSendWindowStart, SendWindowSchema, warmupCap, warmupDay } from '@ri/shared';
import { windowEnd } from '../throttle/windows.js';
import type { EmailJobData, RateLimitNotice } from './queues.js';

export type ProcessorConfig = {
  maxPerWindowGlobal: number;
  maxPerWindowPerSender: number;
  staleSendingMs: number;
  /** Circuit breaker: pause a sender after this many failed sends in a row (0 = never). */
  pauseAfterFailures?: number;
  pauseMs?: number;
};

export type SenderPausedNotice = { senderId: string; senderEmail: string; userId: string; until: string; reason: string };

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
  /** Called when the circuit breaker pauses a sender (→ live toast + Slack). */
  onSenderPaused?: (notice: SenderPausedNotice) => Promise<void>;
  /** Reads a campaign's attachments (cached). Defaults to Postgres; tests can swap it. */
  loadAttachments?: AttachmentLoader;
  /** Called when bounce protection pauses a campaign (→ live toast + Slack). */
  onCampaignPaused?: (notice: CampaignPausedNotice) => Promise<void>;
};

export type CampaignPausedNotice = { campaignId: string; userId: string; subject: string; bounceRate: number; threshold: number; bounced: number; attempts: number };

export type EmailChange = { userId: string; campaignId: string; status: string; /** True for a permanent rejection (hard bounce). */ bounced?: boolean; error?: string };

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
  const loadAttachments = deps.loadAttachments ?? createAttachmentLoader(prisma);

  /** Records history (timeline/analytics) and notifies listeners. Never breaks the send path. */
  const changed = async (
    e: { id: string; userId: string; campaignId: string },
    status: string,
    type: EmailEventType,
    meta?: Prisma.InputJsonValue,
    extra?: { bounced?: boolean; error?: string },
  ) => {
    try {
      await prisma.emailEvent.create({ data: { emailId: e.id, userId: e.userId, type, meta } });
      await deps.onEmailChanged?.(e.id, { userId: e.userId, campaignId: e.campaignId, status, ...extra });
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

    // Circuit breaker: a paused sender's emails wait (no quota held) until the cool-down ends.
    const pausedUntil = email.sender.pausedUntil?.getTime() ?? 0;
    if (pausedUntil > now) {
      await prisma.email.updateMany({ where: { id: emailId, status: { in: [...CLAIMABLE] } }, data: { nextAttemptAt: new Date(pausedUntil) } });
      return delay(job, token, pausedUntil);
    }

    // Warm-up ramp: today's daily cap for this sender (none once warm-up is complete).
    const s = email.sender;
    const warmupToday =
      s.warmupEnabled && s.warmupStartedAt
        ? warmupCap({ start: s.warmupStart, increment: s.warmupIncrement, target: s.warmupTarget }, warmupDay(s.warmupStartedAt.getTime(), now, limiter.dayMs))
        : null;
    // The account's own daily limit and the warm-up ramp both apply: the lower one wins.
    const dailyCap = warmupToday === null ? s.dailyLimit : s.dailyLimit === null ? warmupToday : Math.min(warmupToday, s.dailyLimit);

    const limits = {
      global: config.maxPerWindowGlobal,
      sender: email.sender.hourlyLimit ?? config.maxPerWindowPerSender,
      campaign: email.campaign.hourlyLimit,
      daily: dailyCap ?? undefined,
    };

    // A ticket reserved earlier is only valid inside the window it was counted in.
    let ticket: Ticket | undefined = job.data.ticket;
    if (ticket && now >= windowEnd(ticket.w, limiter.opts.windowMs)) {
      // Unused reservation from a window that has passed (e.g. worker was down): give it back.
      await limiter.refund(ticket, email.senderId, email.campaignId);
      ticket = undefined;
    }

    if (!ticket) {
      const res = await limiter.acquire({ now, senderId: email.senderId, campaignId: email.campaignId, limits, minDelayMs: s.minDelayMs ?? undefined });
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
        const scopeId = res.scope === 'global' ? 'all' : res.scope === 'campaign' ? email.campaignId : email.senderId;
        if (await limiter.firstHitInWindow(res.scope, scopeId, res.w)) {
          log.info({ scope: res.scope, retryAt: new Date(res.retryAt).toISOString() }, 'rate limit reached');
          await deps
            .onRateLimited({
              userId: email.campaign.userId,
              senderId: email.senderId,
              senderEmail: email.sender.email,
              scope: res.scope,
              limit: limits[res.scope] ?? 0,
              windowStart: new Date(limiter.windowStartFor(res.scope, res.w)).toISOString(),
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
    const notBefore = await limiter.gate(email.senderId, dispatchAt, s.minDelayMs ?? undefined);
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
      const attachments = await loadAttachments(email.campaignId);
      const result = await send(email.sender, {
        emailId,
        to: email.toEmail,
        toName: email.toName,
        subject: email.subject,
        body: email.body,
        bodyIsHtml: email.bodyIsHtml,
        ...(attachments.length ? { attachments } : {}),
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
      if (email.sender.consecutiveFailures > 0) {
        await prisma.sender.updateMany({ where: { id: email.senderId }, data: { consecutiveFailures: 0 } }).catch(() => undefined);
      }
      await changed(email, 'SENT', 'SENT', { sender: email.sender.email, previewUrl: result.previewUrl });
      return { outcome: 'sent' };
    } catch (err) {
      await limiter.refund(ticket, email.senderId, email.campaignId);
      const message = err instanceof Error ? err.message : String(err);
      // A hard bounce (recipient doesn't exist / rejected) will never succeed: fail it now, no retries.
      const bounce = isHardBounce(message);
      const final = bounce || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await recordSenderFailure(email, message, bounce);
      await prisma.email.update({
        where: { id: emailId },
        data: final
          ? { status: 'FAILED', failedAt: new Date(), lockedAt: null, lastError: message, ...(bounce ? { bouncedAt: new Date() } : {}) }
          : { status: 'SCHEDULED', lockedAt: null, lastError: message },
      });
      await job.updateData({ emailId }); // a retry must re-acquire a fresh slot
      await changed(email, final ? 'FAILED' : 'SCHEDULED', final ? 'FAILED' : 'SEND_ERROR', {
        error: message,
        attempt: job.attemptsMade + 1,
        final,
      }, { bounced: bounce, error: message.slice(0, 300) });
      log.warn({ err: message, final, attempt: job.attemptsMade + 1 }, 'send failed');
      if (bounce) {
        await job.discard(); // stop BullMQ from retrying a permanent failure
        // Protect the sender: never email a bounced address again (the campaign owner's do-not-contact list).
        await prisma.suppressedEmail
          .upsert({ where: { userId_email: { userId: email.campaign.userId, email: email.toEmail } }, create: { userId: email.campaign.userId, email: email.toEmail }, update: {} })
          .catch(() => undefined);
        await protectFromBounces(email.campaignId);
      }
      throw err; // BullMQ applies exponential backoff; FAILED after the last attempt
    }
  };

  /**
   * Bounce protection: re-judge the campaign each time an address bounces (event-driven, so no timer).
   * The conditional update lets exactly one worker win the pause, so the alert fires once. Emails stay
   * SCHEDULED and their jobs skip while it's paused; Resume re-queues them (see campaigns/controls.ts).
   */
  async function protectFromBounces(campaignId: string) {
    try {
      const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!c || c.status !== 'ACTIVE' || c.bounceThresholdPercent <= 0) return;
      const [sent, bounced] = await Promise.all([
        prisma.email.count({ where: { campaignId, status: 'SENT' } }),
        prisma.email.count({ where: { campaignId, bouncedAt: { not: null } } }),
      ]);
      const verdict = bounceVerdict({ sent, bounced }, { thresholdPercent: c.bounceThresholdPercent, minSends: c.bounceMinSends });
      if (!verdict.breached) return;
      const won = await prisma.campaign.updateMany({ where: { id: campaignId, status: 'ACTIVE' }, data: { status: 'PAUSED', pauseReason: 'BOUNCE_PROTECTION' } });
      if (won.count !== 1) return;
      const pending = await prisma.email.findMany({ where: { campaignId, status: { in: [...CLAIMABLE] } }, select: { id: true } });
      for (let i = 0; i < pending.length; i += 1000) {
        await prisma.emailEvent.createMany({ data: pending.slice(i, i + 1000).map((p) => ({ emailId: p.id, userId: c.userId, type: 'PAUSED' as const, meta: { reason: 'bounce_protection' } })) });
      }
      const rate = Math.round(verdict.ratePercent! * 10) / 10;
      logger.warn({ campaignId, bounced, attempts: verdict.attempts, rate }, 'campaign paused by bounce protection');
      await deps.onCampaignPaused?.({ campaignId, userId: c.userId, subject: c.subject, bounceRate: rate, threshold: c.bounceThresholdPercent, bounced, attempts: verdict.attempts }).catch(() => undefined);
    } catch (e) {
      logger.warn({ err: e }, 'bounce protection check failed (send path unaffected)');
    }
  }

  /**
   * Circuit breaker bookkeeping. Sender-side failures count toward a pause; a hard bounce is the
   * recipient's problem, so it doesn't. A login error pauses immediately — retrying can't fix it.
   */
  async function recordSenderFailure(email: { senderId: string; sender: { email: string }; campaign: { userId: string } }, message: string, bounce: boolean) {
    try {
      if (bounce) {
        await prisma.sender.update({ where: { id: email.senderId }, data: { lastError: message.slice(0, 500) } });
        return;
      }
      const updated = await prisma.sender.update({
        where: { id: email.senderId },
        data: { consecutiveFailures: { increment: 1 }, lastError: message.slice(0, 500) },
      });
      const threshold = config.pauseAfterFailures ?? 0;
      const auth = isAuthError(message);
      const alreadyPaused = (updated.pausedUntil?.getTime() ?? 0) > Date.now();
      if (alreadyPaused || (!auth && (threshold <= 0 || updated.consecutiveFailures < threshold))) return;
      const until = new Date(Date.now() + (config.pauseMs ?? 30 * 60_000));
      const reason = auth ? `Login rejected by the SMTP server: ${message.slice(0, 160)}` : `${updated.consecutiveFailures} sends in a row failed (last: ${message.slice(0, 160)})`;
      // Only one worker wins the pause (conditional update), so the alert fires once.
      const won = await prisma.sender.updateMany({
        where: { id: email.senderId, OR: [{ pausedUntil: null }, { pausedUntil: { lt: new Date() } }] },
        data: { pausedUntil: until, pauseReason: reason },
      });
      if (won.count === 1) {
        logger.warn({ sender: email.sender.email, until: until.toISOString(), reason }, 'sender paused by circuit breaker');
        await deps.onSenderPaused?.({ senderId: email.senderId, senderEmail: email.sender.email, userId: email.campaign.userId, until: until.toISOString(), reason }).catch(() => undefined);
      }
    } catch (e) {
      logger.warn({ err: e }, 'recording sender failure failed (send path unaffected)');
    }
  }
}
