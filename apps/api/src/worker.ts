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
      onRateLimited: rateLimitRecorder(prisma, queues, redis),
      onSenderPaused: async (n) => {
        await publishLive(redis, n.userId, { type: 'sender.paused', senderEmail: n.senderEmail, until: n.until, reason: n.reason });
        await queues.notify.add('sender-paused', { kind: 'sender-paused', notice: n });
      },
      onEmailChanged: async (id, c) => {
        await enqueueIndex(queues.index, [id]);
        await publishLive(redis, c.userId, { type: 'email.updated', emailId: id, campaignId: c.campaignId, status: c.status });
      },
    },
  );

  const notifyWorker = startNotifyWorker(
    { connection: createRedis('notify-worker'), prefix: DEFAULT_PREFIX },
    async (job) => {
      if (job.kind === 'sender-paused') {
        const result = await slack.notifySenderPaused(job.notice);
        logger.info({ result, sender: job.notice.senderEmail }, 'sender-paused notice');
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
