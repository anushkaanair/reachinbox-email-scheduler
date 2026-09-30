import { z } from 'zod';
import { CampaignPauseReasonSchema } from './bounce.js';
import { CampaignStatusSchema } from './email.js';

export const CampaignSummarySchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: CampaignStatusSchema,
  createdAt: z.string(),
  startAt: z.string(),
  delayBetweenMs: z.number(),
  hourlyLimit: z.number(),
  total: z.number(),
  counts: z.object({
    scheduled: z.number(),
    rateLimited: z.number(),
    sending: z.number(),
    sent: z.number(),
    failed: z.number(),
    cancelled: z.number(),
  }),
  /** Latest nextAttemptAt of any pending email, i.e. when the campaign should finish. */
  lastPendingAt: z.string().nullable(),
  /** Hard bounces so far, and their share of attempted emails (null until something was attempted). */
  bounced: z.number(),
  bounceRate: z.number().nullable(),
  bounceProtection: z.object({ thresholdPercent: z.number(), minSends: z.number() }),
  /** Set when the campaign paused itself (not a person). */
  pauseReason: CampaignPauseReasonSchema.nullable(),
  /** All the campaign's waiting emails belong to senders that are paused or removed, so nothing will go out yet. */
  senderBlocked: z.enum(['PAUSED', 'INACTIVE']).nullable(),
});
export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

export const AnalyticsSchema = z.object({
  hours: z.number(),
  windowSeconds: z.number(),
  totals: z.object({ sent: z.number(), failed: z.number(), rateLimited: z.number(), pending: z.number() }),
  hourly: z.array(z.object({ hour: z.string(), sent: z.number(), failed: z.number(), rateLimited: z.number() })),
  senders: z.array(
    z.object({ id: z.string(), email: z.string(), used: z.number(), limit: z.number(), sent24h: z.number() }),
  ),
});
export type Analytics = z.infer<typeof AnalyticsSchema>;
