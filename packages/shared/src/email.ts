import { z } from 'zod';

/** Mirrors the Prisma `EmailStatus` enum. The state machine is documented in GODFATHER §4. */
export const EMAIL_STATUSES = [
  'SCHEDULED',
  'RATE_LIMITED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
] as const;
export const EmailStatusSchema = z.enum(EMAIL_STATUSES);
export type EmailStatus = z.infer<typeof EmailStatusSchema>;

/** Dashboard tabs group several raw statuses. */
export const EMAIL_TABS = ['scheduled', 'sent'] as const;
export const EmailTabSchema = z.enum(EMAIL_TABS);
export type EmailTab = z.infer<typeof EmailTabSchema>;

export const TAB_STATUSES: Record<EmailTab, readonly EmailStatus[]> = {
  scheduled: ['SCHEDULED', 'RATE_LIMITED', 'SENDING'],
  sent: ['SENT', 'FAILED'],
};

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

/** Single source of truth for how a status is labelled and coloured in the UI. */
export const STATUS_META: Record<EmailStatus, { label: string; tone: StatusTone }> = {
  SCHEDULED: { label: 'Scheduled', tone: 'info' },
  RATE_LIMITED: { label: 'Rate limited', tone: 'warning' },
  SENDING: { label: 'Sending', tone: 'info' },
  SENT: { label: 'Sent', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export const CAMPAIGN_STATUSES = ['ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED'] as const;
export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const EmailRowSchema = z.object({
  id: z.string(),
  campaignId: z.string(),
  campaignStatus: CampaignStatusSchema,
  toEmail: z.string(),
  toName: z.string().nullable(),
  subject: z.string(),
  status: EmailStatusSchema,
  senderEmail: z.string(),
  scheduledAt: z.string(),
  nextAttemptAt: z.string(),
  sentAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  previewUrl: z.string().nullable(),
  /** Body snippet for the list row. */
  preview: z.string(),
  starred: z.boolean(),
});
export type EmailRow = z.infer<typeof EmailRowSchema>;

export const ListEmailsQuerySchema = z.object({
  status: EmailTabSchema.default('scheduled'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Filter popover: only starred emails. */
  starred: z.enum(['true']).optional(),
  /** Filter popover on the Sent tab: only delivered, or only failed. */
  outcome: z.enum(['SENT', 'FAILED']).optional(),
});
export type ListEmailsQuery = z.infer<typeof ListEmailsQuerySchema>;

export const ListEmailsResponseSchema = z.object({
  items: z.array(EmailRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListEmailsResponse = z.infer<typeof ListEmailsResponseSchema>;

export const EMAIL_EVENT_TYPES = [
  'SCHEDULED',
  'RATE_LIMITED',
  'SEND_ERROR',
  'SENT',
  'FAILED',
  'RETRIED',
  'CANCELLED',
  'PAUSED',
  'RESUMED',
] as const;
export const EmailEventSchema = z.object({
  type: z.enum(EMAIL_EVENT_TYPES),
  at: z.string(),
  meta: z.record(z.unknown()).nullable(),
});
export type EmailEvent = z.infer<typeof EmailEventSchema>;

export const EmailDetailSchema = EmailRowSchema.extend({
  body: z.string(),
  messageId: z.string().nullable(),
  attempts: z.number(),
  rateLimitedCount: z.number(),
  dispatchedAt: z.string().nullable(),
  createdAt: z.string(),
  events: z.array(EmailEventSchema),
});
export type EmailDetail = z.infer<typeof EmailDetailSchema>;

export const StarUpdateSchema = z.object({ starred: z.boolean() });

/** The grey snippet after the subject: whitespace collapsed, cut at a word boundary where possible. */
export function makePreview(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export const EmailCountsSchema = z.object({
  scheduled: z.number(),
  sent: z.number(),
  failed: z.number(),
});
export type EmailCounts = z.infer<typeof EmailCountsSchema>;
