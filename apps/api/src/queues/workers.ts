import { Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { publishLive } from '../lib/live.js';
import { QUEUES } from './names.js';
import { createEmailProcessor, type ProcessorDeps, type ProcessResult } from './emailProcessor.js';
import type { EmailSearch } from '../modules/search/emailSearch.js';
import type { EmailJobData, IndexJobData, NotifyJobData, QueueSet, RateLimitNotice } from './queues.js';

export function startEmailWorker(
  opts: { connection: Redis; prefix: string; concurrency: number },
  deps: ProcessorDeps,
): Worker<EmailJobData, ProcessResult> {
  const worker = new Worker<EmailJobData, ProcessResult>(QUEUES.EMAIL, createEmailProcessor(deps), {
    connection: opts.connection,
    prefix: opts.prefix,
    concurrency: opts.concurrency,
    lockDuration: 60_000,
    // A job that stalls (worker died) is re-delivered once; the DB claim makes that safe.
    maxStalledCount: 1,
  });
  worker.on('failed', (job, err) => deps.logger.warn({ jobId: job?.id, err: err.message }, 'email job failed'));
  worker.on('error', (err) => deps.logger.error({ err }, 'email worker error'));
  return worker;
}

/** Records the hit (audit + analytics) and hands off to the notifications queue. */
export function rateLimitRecorder(prisma: PrismaClient, queues: QueueSet, redis?: Redis) {
  return async (notice: RateLimitNotice) => {
    await prisma.rateLimitEvent.upsert({
      where: {
        senderId_userId_scope_windowKey: {
          senderId: notice.senderId,
          userId: notice.userId,
          scope: notice.scope,
          windowKey: notice.windowStart,
        },
      },
      create: { senderId: notice.senderId, userId: notice.userId, scope: notice.scope, windowKey: notice.windowStart },
      update: {},
    });
    await queues.notify.add('rate-limit', { kind: 'rate-limit', notice });
    // In-app mirror of the Slack alert (toast in the dashboard).
    if (redis) {
      await publishLive(redis, notice.userId, {
        type: 'ratelimit.hit',
        senderEmail: notice.senderEmail,
        scope: notice.scope,
        limit: notice.limit,
        retryAt: notice.retryAt,
      });
    }
  };
}

/** Search indexing worker: rebuilds ES documents from Postgres (idempotent). */
export function startIndexWorker(
  opts: { connection: Redis; prefix: string },
  search: EmailSearch,
  logger: Logger,
): Worker<IndexJobData> {
  const worker = new Worker<IndexJobData>(QUEUES.INDEX, (job) => search.indexEmails(job.data.emailIds), {
    connection: opts.connection,
    prefix: opts.prefix,
    concurrency: 5,
  });
  worker.on('failed', (job, err) => logger.warn({ jobId: job?.id, err: err.message }, 'index job failed (will retry)'));
  worker.on('error', (err) => logger.error({ err }, 'index worker error'));
  return worker;
}

/**
 * Notifications worker. Phase 3 plugs the Slack notifier in here; until then (or when the user
 * hasn't connected Slack) a rate-limit hit is logged and acknowledged — never a crash.
 */
export function startNotifyWorker(
  opts: { connection: Redis; prefix: string },
  handler: (data: NotifyJobData, attempt: { made: number; max: number }) => Promise<void>,
  logger: Logger,
): Worker<NotifyJobData> {
  const worker = new Worker<NotifyJobData>(QUEUES.NOTIFY, (job) => handler(job.data, { made: job.attemptsMade, max: job.opts.attempts ?? 1 }), {
    connection: opts.connection,
    prefix: opts.prefix,
    concurrency: 2,
  });
  worker.on('error', (err) => logger.error({ err }, 'notify worker error'));
  return worker;
}
