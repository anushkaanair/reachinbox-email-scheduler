import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import type { Ticket } from '../throttle/rateLimiter.js';
import { QUEUES } from './names.js';

/** Jobs carry only the email id (+ a throttle ticket). Postgres is the source of truth. */
export type EmailJobData = { emailId: string; ticket?: Ticket };

export type RateLimitNotice = {
  userId: string;
  senderId: string;
  senderEmail: string;
  scope: 'global' | 'sender' | 'campaign';
  limit: number;
  windowStart: string;
  retryAt: string;
};
export type NotifyJobData = { kind: 'rate-limit'; notice: RateLimitNotice };
export type IndexJobData = { emailIds: string[] };

export type QueueSet = {
  email: Queue<EmailJobData>;
  notify: Queue<NotifyJobData>;
  index: Queue<IndexJobData>;
};

/** BullMQ key prefix — tests pass a random one to isolate from a running dev worker. */
export const DEFAULT_PREFIX = 'bull';

export function createQueues(connection: Redis, prefix = DEFAULT_PREFIX): QueueSet {
  return {
    email: new Queue<EmailJobData>(QUEUES.EMAIL, { connection, prefix }),
    notify: new Queue<NotifyJobData>(QUEUES.NOTIFY, {
      connection,
      prefix,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 14 * 24 * 3600 },
      },
    }),
    // Search indexing is off the send path: if Elasticsearch is down, jobs just retry.
    index: new Queue<IndexJobData>(QUEUES.INDEX, {
      connection,
      prefix,
      defaultJobOptions: {
        attempts: 8,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
  };
}

export const closeQueues = (q: QueueSet) => Promise.all([q.email.close(), q.notify.close(), q.index.close()]);

/** Chunked so one campaign of 10k emails becomes 20 index jobs, not 10k. */
export async function enqueueIndex(queue: Queue<IndexJobData>, ids: string[], chunkSize = 500): Promise<void> {
  for (let i = 0; i < ids.length; i += chunkSize) {
    await queue.add('index', { emailIds: ids.slice(i, i + chunkSize) });
  }
}

export const emailJobOptions = (emailId: string, runAt: Date, now = Date.now()): JobsOptions => ({
  // Queue-level idempotency: BullMQ ignores an add whose jobId already exists.
  jobId: emailId,
  delay: Math.max(0, runAt.getTime() - now),
  attempts: env.EMAIL_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: false,
});

/** Enqueue in chunks; safe to call repeatedly with the same rows (jobId dedupe). */
export async function enqueueEmails(
  queue: Queue<EmailJobData>,
  rows: { id: string; nextAttemptAt: Date }[],
  chunkSize = 500,
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < rows.length; i += chunkSize) {
    await queue.addBulk(
      rows.slice(i, i + chunkSize).map((r) => ({
        name: 'send',
        data: { emailId: r.id },
        opts: emailJobOptions(r.id, r.nextAttemptAt, now),
      })),
    );
  }
}
