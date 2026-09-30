/**
 * Worker process entry — runs separately from the API so either can be restarted independently
 * (GODFATHER §3). Boot order: reconcile DB ↔ Redis once, then start consuming.
 */
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createRedis, redis } from './lib/redis.js';
import { onShutdown } from './lib/shutdown.js';
import { closeTransports, sendViaSmtp } from './mail/transport.js';
import { es } from './lib/elasticsearch.js';
import { publishLive } from './lib/live.js';
import { createEmitter, deliverJob } from './modules/webhooks/service.js';
import { EmailSearch } from './modules/search/emailSearch.js';
import { createSlackService } from './modules/slack/index.js';
import { DEFAULT_PREFIX, closeQueues, createQueues, enqueueIndex } from './queues/queues.js';
import { rateLimitRecorder, startEmailWorker, startIndexWorker, startNotifyWorker } from './queues/workers.js';
import { reconcile } from './recovery/reconciler.js';
import { RateLimiter } from './throttle/rateLimiter.js';

async function main() {
  await prisma.$connect();
  const queues = createQueues(redis);
  const limiter = new RateLimiter(redis, {
    prefix: '',
    windowMs: env.RATE_WINDOW_SECONDS * 1000,
    minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
    dayMs: env.WARMUP_DAY_SECONDS * 1000,
  });

  const search = new EmailSearch(es, prisma, env.ES_INDEX);
  await search.ensureIndex().catch((err) => logger.warn({ err: err.message }, 'elasticsearch unavailable; index jobs will retry'));
  const slack = createSlackService();
  const emit = createEmitter(prisma, queues.notify);
  const webhookDeps = { prisma, allowPrivate: env.ALLOW_PRIVATE_WEBHOOK_HOSTS };

  await reconcile({ prisma, queue: queues.email, logger, staleSendingMs: env.STALE_SENDING_MS });

  // Workers use blocking commands, so each gets its own connection.
  const emailWorker = startEmailWorker(
    { connection: createRedis('email-worker'), prefix: DEFAULT_PREFIX, concurrency: env.WORKER_CONCURRENCY },
    {
      prisma,
      limiter,
      send: sendViaSmtp,
      logger,
      config: {
        maxPerWindowGlobal: env.MAX_EMAILS_PER_HOUR,
        maxPerWindowPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        staleSendingMs: env.STALE_SENDING_MS,
        pauseAfterFailures: env.SENDER_PAUSE_AFTER_FAILURES,
        pauseMs: env.SENDER_PAUSE_MINUTES * 60_000,
      },
      onRateLimited: async (n) => {
        await rateLimitRecorder(prisma, queues, redis)(n);
        await emit(n.userId, 'rate_limit.hit', null, () => ({ sender: n.senderEmail, scope: n.scope, limit: n.limit, windowStart: n.windowStart, resumesAt: n.retryAt })).catch(() => undefined);
      },
      onSenderPaused: async (n) => {
        await publishLive(redis, n.userId, { type: 'sender.paused', senderEmail: n.senderEmail, until: n.until, reason: n.reason });
        await queues.notify.add('sender-paused', { kind: 'sender-paused', notice: n });
        await emit(n.userId, 'sender.paused', null, () => ({ sender: n.senderEmail, until: n.until, reason: n.reason })).catch(() => undefined);
      },
      onCampaignPaused: async (n) => {
        await publishLive(redis, n.userId, { type: 'campaign.auto_paused', campaignId: n.campaignId, subject: n.subject, bounceRate: n.bounceRate, threshold: n.threshold });
        await publishLive(redis, n.userId, { type: 'campaign.updated', campaignId: n.campaignId, status: 'PAUSED' });
        await queues.notify.add('campaign-paused', { kind: 'campaign-paused', notice: n });
        await emit(n.userId, 'campaign.auto_paused', n.campaignId, () => ({ campaignId: n.campaignId, subject: n.subject, bounceRate: n.bounceRate, thresholdPercent: n.threshold, bounced: n.bounced, attempts: n.attempts })).catch(() => undefined);
      },
      onEmailChanged: async (id, c) => {
        await enqueueIndex(queues.index, [id]);
        await publishLive(redis, c.userId, { type: 'email.updated', emailId: id, campaignId: c.campaignId, status: c.status });
        if (c.status === 'SENT' || c.status === 'FAILED') {
          // Webhooks: the email's details are only read if someone is listening for this event.
          const details = async () => {
            const e = await prisma.email.findUnique({ where: { id }, select: { toEmail: true, subject: true, messageId: true, sentAt: true, failedAt: true, sender: { select: { email: true } } } });
            return { emailId: id, campaignId: c.campaignId, to: e?.toEmail ?? null, subject: e?.subject ?? null, sender: e?.sender.email ?? null, messageId: e?.messageId ?? null, sentAt: e?.sentAt?.toISOString() ?? null, ...(c.status === 'FAILED' ? { error: c.error ?? null } : {}) };
          };
          await emit(c.userId, c.status === 'SENT' ? 'email.sent' : 'email.failed', c.campaignId, details).catch(() => undefined);
          if (c.bounced) await emit(c.userId, 'email.bounced', c.campaignId, details).catch(() => undefined);
        }
      },
    },
  );

  const notifyWorker = startNotifyWorker(
    { connection: createRedis('notify-worker'), prefix: DEFAULT_PREFIX },
    async (job, attempt) => {
      if (job.kind === 'webhook') {
        await deliverJob(webhookDeps, job, attempt); // throws on failure, so BullMQ retries with backoff
        return;
      }
      if (job.kind === 'sender-paused') {
        const result = await slack.notifySenderPaused(job.notice);
        logger.info({ result, sender: job.notice.senderEmail }, 'sender-paused notice');
        return;
      }
      if (job.kind === 'campaign-paused') {
        const result = await slack.notifyCampaignPaused(job.notice);
        logger.info({ result, campaignId: job.notice.campaignId }, 'campaign-paused notice');
        return;
      }
      const { notice } = job;
      const result = await slack.notifyRateLimit(notice);
      if (result === 'sent') {
        await prisma.rateLimitEvent.updateMany({
          where: { senderId: notice.senderId, userId: notice.userId, scope: notice.scope, windowKey: notice.windowStart },
          data: { notified: true },
        });
      }
      logger.info({ result, sender: notice.senderEmail, scope: notice.scope, userId: notice.userId }, 'rate-limit notice');
    },
    logger,
  );

  const indexWorker = startIndexWorker({ connection: createRedis('index-worker'), prefix: DEFAULT_PREFIX }, search, logger);

  onShutdown([
    // Stop taking jobs and let in-flight sends finish before closing anything they depend on.
    { name: 'email worker', close: () => emailWorker.close() },
    { name: 'notify worker', close: () => notifyWorker.close() },
    { name: 'index worker', close: () => indexWorker.close() },
    { name: 'queues', close: () => closeQueues(queues) },
    { name: 'smtp', close: closeTransports },
    { name: 'prisma', close: () => prisma.$disconnect() },
    { name: 'redis', close: () => redis.quit() },
  ]);

  logger.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      maxPerWindow: env.MAX_EMAILS_PER_HOUR,
      maxPerSenderPerWindow: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      windowSeconds: env.RATE_WINDOW_SECONDS,
    },
    'worker running',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
