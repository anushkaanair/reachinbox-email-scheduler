import { z } from 'zod';
import { LeadSchema, MAX_LEADS_PER_CAMPAIGN } from './campaign.js';
import { MAX_SEND_LAYERS, SendLayerSchema } from './sendWindow.js';

/** A saved compose form. Client-shaped on purpose: it restores exactly what the person had on screen. */
export const MAX_DRAFTS = 20;

export const DraftRulesSchema = z.object({
  hoursOn: z.boolean(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  timezone: z.string().min(1).max(64),
  weekdaysOnly: z.boolean(),
  /** Day-specific hours (absent in drafts saved before they existed). */
  layers: z.array(SendLayerSchema).max(MAX_SEND_LAYERS).optional(),
  skipOn: z.boolean(),
  skipDays: z.number().int().min(1).max(365),
  bounceOn: z.boolean(),
  bounceThreshold: z.number().int().min(1).max(100),
});

export const DraftPayloadSchema = z.object({
  senderId: z.string().max(64).default(''),
  subject: z.string().max(300).default(''),
  /** The editor's HTML. Sanitised again whenever it is sent, never trusted here. */
  body: z.string().max(50_000).default(''),
  leads: z.array(LeadSchema).max(MAX_LEADS_PER_CAMPAIGN).default([]),
  /** Null = send straight away. */
  sendAt: z.string().datetime({ offset: true }).nullable().default(null),
  delayBetweenSeconds: z.number().int().min(0).max(86_400).default(2),
  hourlyLimit: z.number().int().min(1).max(10_000).default(50),
  jitterPercent: z.number().int().min(0).max(50).default(0),
  rules: DraftRulesSchema.optional(),
});
export type DraftPayload = z.infer<typeof DraftPayloadSchema>;

export const DraftSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  recipients: z.number(),
  updatedAt: z.string(),
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;

export const DraftSchema = DraftSummarySchema.extend({ payload: DraftPayloadSchema });
export type Draft = z.infer<typeof DraftSchema>;

/** The title shown in the list: the subject, or a placeholder when it is still blank. */
export const draftTitle = (p: Pick<DraftPayload, 'subject'>) => p.subject.trim().slice(0, 120) || '(no subject yet)';
