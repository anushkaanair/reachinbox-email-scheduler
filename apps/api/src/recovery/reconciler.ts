import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { enqueueEmails, type EmailJobData } from '../queues/queues.js';

export type ReconcileReport = { staleFailed: number; requeued: number; checked: number };

/**
 * Runs ONCE when a worker process boots (not periodically — no cron). Repairs any drift between
 * Postgres (truth) and Redis (schedule):
 *  1. Rows stuck in SENDING past the stale threshold → FAILED (at-most-once; never re-sent).
 *  2. SCHEDULED/RATE_LIMITED rows without a live job (Redis wiped, crash between DB commit and
 *     enqueue, …) → re-enqueued with the SAME jobId at their nextAttemptAt. Past-due rows run
 *     immediately but still pass through the rate limiter, so a backlog stays throttled.
 */
export async function reconcile(deps: {
  prisma: PrismaClient;
  queue: Queue<EmailJobData>;
  logger: Logger;
  staleSendingMs: number;
  batchSize?: number;
}): Promise<ReconcileReport> {
  const { prisma, queue, logger, staleSendingMs, batchSize = 1000 } = deps;

  const stale = await prisma.email.updateMany({
    where: { status: 'SENDING', lockedAt: { lt: new Date(Date.now() - staleSendingMs) } },
    data: { status: 'FAILED', failedAt: new Date(), lockedAt: null, lastError: 'interrupted_before_confirmation' },
  });

  let requeued = 0;
  let checked = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.email.findMany({
      where: { status: { in: ['SCHEDULED', 'RATE_LIMITED'] } },
      select: { id: true, nextAttemptAt: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows.at(-1)!.id;
    checked += rows.length;

    const states = await Promise.all(rows.map((r) => queue.getJobState(r.id)));
    const missing: typeof rows = [];
    for (let i = 0; i < rows.length; i++) {
      const state = states[i];
      if (state === 'unknown') missing.push(rows[i]!);
      // A finished job for a row that still needs sending: drop the stale job so the same id can be re-added.
      else if (state === 'completed' || state === 'failed') {
        await queue.remove(rows[i]!.id);
        missing.push(rows[i]!);
      }
    }
    if (missing.length) {
      await enqueueEmails(queue, missing);
      requeued += missing.length;
    }
  }

  const report = { staleFailed: stale.count, requeued, checked };
  logger.info(report, 'boot reconciliation complete');
  return report;
}
