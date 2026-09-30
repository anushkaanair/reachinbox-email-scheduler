import { z } from 'zod';

/**
 * Webhooks: signed HTTP POSTs to a URL you choose when things happen. Every delivery carries
 *   X-ReachInbox-Event, X-ReachInbox-Delivery (unique id), X-ReachInbox-Timestamp (unix seconds) and
 *   X-ReachInbox-Signature: sha256=<hex HMAC-SHA256 of `${timestamp}.${rawBody}` with your secret>
 * so the receiver can check who sent it and reject replays.
 */
export const WEBHOOK_EVENTS = ['email.sent', 'email.failed', 'email.bounced', 'campaign.auto_paused', 'sender.paused', 'rate_limit.hit'] as const;
export const WebhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const WEBHOOK_EVENT_LABEL: Record<WebhookEvent, string> = {
  'email.sent': 'An email was sent',
  'email.failed': 'An email failed (after all retries)',
  'email.bounced': 'An address bounced',
  'campaign.auto_paused': 'A campaign paused itself (bounce protection)',
  'sender.paused': 'A sender was paused',
  'rate_limit.hit': 'A sending limit was reached',
};

export const MAX_WEBHOOKS = 10;
/** Give up (and switch the webhook off) after this many deliveries in a row that all retries failed. */
export const WEBHOOK_DISABLE_AFTER = 15;

export const WebhookCreateSchema = z.object({
  url: z.string().trim().url('Enter a full URL, like https://example.com/hook').max(2000).refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// URL'),
  events: z.array(WebhookEventSchema).min(1, 'Choose at least one event').max(WEBHOOK_EVENTS.length),
  /** Only this campaign's events (null/absent = all campaigns). */
  campaignId: z.string().max(64).nullable().optional(),
});
export type WebhookCreate = z.infer<typeof WebhookCreateSchema>;

export const WebhookUpdateSchema = z.object({
  url: WebhookCreateSchema.shape.url.optional(),
  events: WebhookCreateSchema.shape.events.optional(),
  campaignId: z.string().max(64).nullable().optional(),
  active: z.boolean().optional(),
});
export type WebhookUpdate = z.infer<typeof WebhookUpdateSchema>;

export const WebhookSummarySchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(WebhookEventSchema),
  campaignId: z.string().nullable(),
  active: z.boolean(),
  failureCount: z.number(),
  lastDeliveryAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  createdAt: z.string(),
});
export type WebhookSummary = z.infer<typeof WebhookSummarySchema>;

/** Returned once when a webhook is created or its secret rotated; it can never be read again. */
export const WebhookWithSecretSchema = WebhookSummarySchema.extend({ secret: z.string() });
export type WebhookWithSecret = z.infer<typeof WebhookWithSecretSchema>;

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  event: z.string(),
  ok: z.boolean(),
  httpStatus: z.number().nullable(),
  error: z.string().nullable(),
  attempt: z.number(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

/** What a receiver gets as the JSON body. */
export type WebhookPayload = { id: string; type: WebhookEvent | 'ping'; createdAt: string; data: Record<string, unknown> };

/** The exact bytes the signature covers. Kept here so the docs example and the server cannot drift apart. */
export const signedString = (timestamp: string, rawBody: string) => `${timestamp}.${rawBody}`;
