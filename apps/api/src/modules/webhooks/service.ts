import { randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, Webhook } from '@prisma/client';
import {
  MAX_WEBHOOKS,
  WEBHOOK_DISABLE_AFTER,
  WebhookEventSchema,
  type WebhookCreate,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookPayload,
  type WebhookSummary,
  type WebhookUpdate,
} from '@ri/shared';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { QueueSet } from '../../queues/queues.js';
import { assertSafeUrl, buildPayload, postWebhook, type DeliveryResult } from './deliver.js';

export type WebhookDeps = { prisma: PrismaClient; allowPrivate: boolean };

const KEEP_DELIVERIES = 50;
const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

export const toSummary = (w: Webhook): WebhookSummary => ({
  id: w.id,
  url: w.url,
  events: w.events.filter((e): e is WebhookEvent => WebhookEventSchema.safeParse(e).success),
  campaignId: w.campaignId,
  active: w.active,
  failureCount: w.failureCount,
  lastDeliveryAt: w.lastDeliveryAt?.toISOString() ?? null,
  lastStatus: w.lastStatus,
  createdAt: w.createdAt.toISOString(),
});

async function own(prisma: PrismaClient, userId: string, id: string) {
  const w = await prisma.webhook.findFirst({ where: { id, userId } });
  if (!w) throw AppError.notFound('Webhook not found');
  return w;
}

/** The URL is checked now (and again at every delivery), and a campaign filter must be the owner's own campaign. */
async function checked(deps: WebhookDeps, userId: string, url: string | undefined, campaignId: string | null | undefined) {
  if (url !== undefined) await assertSafeUrl(url, deps.allowPrivate).catch((e: Error) => { throw new AppError(422, 'VALIDATION', e.message); });
  if (campaignId && !(await deps.prisma.campaign.findFirst({ where: { id: campaignId, userId }, select: { id: true } }))) throw new AppError(400, 'VALIDATION', 'That campaign doesn’t exist.');
}

export async function createWebhook(deps: WebhookDeps, userId: string, input: WebhookCreate): Promise<WebhookSummary & { secret: string }> {
  if ((await deps.prisma.webhook.count({ where: { userId } })) >= MAX_WEBHOOKS) throw new AppError(409, 'CONFLICT', `You can have up to ${MAX_WEBHOOKS} webhooks.`);
  await checked(deps, userId, input.url, input.campaignId);
  const secret = newSecret();
  const w = await deps.prisma.webhook.create({ data: { userId, url: input.url, secretEnc: encrypt(secret), events: [...new Set(input.events)], campaignId: input.campaignId ?? null } });
  return { ...toSummary(w), secret };
}

export async function updateWebhook(deps: WebhookDeps, userId: string, id: string, input: WebhookUpdate): Promise<WebhookSummary> {
  const cur = await own(deps.prisma, userId, id);
  await checked(deps, userId, input.url, input.campaignId);
  const data: Prisma.WebhookUpdateInput = {};
  if (input.url !== undefined) data.url = input.url;
  if (input.events !== undefined) data.events = [...new Set(input.events)];
  if (input.campaignId !== undefined) data.campaignId = input.campaignId;
  if (input.active !== undefined) {
    data.active = input.active;
    if (input.active && !cur.active) data.failureCount = 0; // switching back on starts from a clean slate
  }
  return toSummary(await deps.prisma.webhook.update({ where: { id }, data }));
}

export async function rotateSecret(deps: WebhookDeps, userId: string, id: string) {
  await own(deps.prisma, userId, id);
  const secret = newSecret();
  const w = await deps.prisma.webhook.update({ where: { id }, data: { secretEnc: encrypt(secret) } });
  return { ...toSummary(w), secret };
}

export async function listWebhooks(prisma: PrismaClient, userId: string): Promise<WebhookSummary[]> {
  return (await prisma.webhook.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(toSummary);
}

export async function deleteWebhook(prisma: PrismaClient, userId: string, id: string) {
  const done = await prisma.webhook.deleteMany({ where: { id, userId } });
  if (done.count === 0) throw AppError.notFound('Webhook not found');
}

export async function listDeliveries(prisma: PrismaClient, userId: string, id: string): Promise<WebhookDelivery[]> {
  await own(prisma, userId, id);
  const rows = await prisma.webhookDelivery.findMany({ where: { webhookId: id }, orderBy: { createdAt: 'desc' }, take: KEEP_DELIVERIES });
  return rows.map((r) => ({ id: r.id, event: r.event, ok: r.ok, httpStatus: r.httpStatus, error: r.error, attempt: r.attempt, createdAt: r.createdAt.toISOString() }));
}

async function record(prisma: PrismaClient, webhookId: string, event: string, r: DeliveryResult, attempt: number) {
  await prisma.webhookDelivery.create({ data: { webhookId, event, ok: r.ok, httpStatus: r.status ?? null, error: r.error ?? null, attempt } });
  const old = await prisma.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: 'desc' }, skip: KEEP_DELIVERIES, select: { id: true } });
  if (old.length) await prisma.webhookDelivery.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

/** "Send test": a signed `ping` right now, so the receiver can be checked before anything real happens. */
export async function testWebhook(deps: WebhookDeps, userId: string, id: string): Promise<DeliveryResult> {
  const w = await own(deps.prisma, userId, id);
  const payload = buildPayload('ping', { message: 'This is a test delivery from ReachInbox.' });
  const r = await postWebhook({ url: w.url, secret: decrypt(w.secretEnc), payload, allowPrivate: deps.allowPrivate });
  await record(deps.prisma, w.id, 'ping', r, 1);
  return r;
}

export type WebhookJob = { webhookId: string; payload: WebhookPayload };

/**
 * One queued delivery. A failure throws so BullMQ retries with backoff; the last failed attempt counts against the
 * webhook, and too many in a row switch it off so a dead receiver doesn't keep getting traffic.
 */
export async function deliverJob(deps: WebhookDeps, job: WebhookJob, attempt: { made: number; max: number }): Promise<void> {
  const w = await deps.prisma.webhook.findUnique({ where: { id: job.webhookId } });
  if (!w || !w.active) return;
  const r = await postWebhook({ url: w.url, secret: decrypt(w.secretEnc), payload: job.payload, allowPrivate: deps.allowPrivate });
  await record(deps.prisma, w.id, job.payload.type, r, attempt.made + 1);
  if (r.ok) {
    await deps.prisma.webhook.update({ where: { id: w.id }, data: { failureCount: 0, lastDeliveryAt: new Date(), lastStatus: 'ok' } });
    return;
  }
  const last = attempt.made + 1 >= attempt.max;
  if (last) {
    const failures = w.failureCount + 1;
    await deps.prisma.webhook.update({ where: { id: w.id }, data: { failureCount: failures, lastDeliveryAt: new Date(), lastStatus: r.error ?? 'failed', ...(failures >= WEBHOOK_DISABLE_AFTER ? { active: false } : {}) } });
  }
  throw new Error(r.error ?? 'Webhook delivery failed');
}

/** Webhooks to call for an event, cached briefly per user: a busy campaign sends thousands of events. */
export function createEmitter(prisma: PrismaClient, queue: QueueSet['notify'], ttlMs = 15_000) {
  const cache = new Map<string, { at: number; hooks: { id: string; events: string[]; campaignId: string | null }[] }>();
  const hooksFor = async (userId: string) => {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < ttlMs) return hit.hooks;
    const hooks = await prisma.webhook.findMany({ where: { userId, active: true }, select: { id: true, events: true, campaignId: true } });
    cache.set(userId, { at: Date.now(), hooks });
    return hooks;
  };
  /** `build` runs only when someone is listening, so events cost nothing for people without webhooks. */
  return async (userId: string, type: WebhookEvent, campaignId: string | null, build: () => Promise<Record<string, unknown>> | Record<string, unknown>) => {
    const targets = (await hooksFor(userId)).filter((h) => h.events.includes(type) && (h.campaignId === null || h.campaignId === campaignId));
    if (targets.length === 0) return 0;
    const payload = buildPayload(type, await build());
    for (const h of targets) await queue.add('webhook', { kind: 'webhook', webhookId: h.id, payload });
    return targets.length;
  };
}
export type Emitter = ReturnType<typeof createEmitter>;
