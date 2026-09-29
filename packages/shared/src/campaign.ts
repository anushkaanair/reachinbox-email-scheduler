import { z } from 'zod';

/** Raw lead as parsed from CSV — the server validates addresses and reports invalid ones back. */
export const LeadSchema = z.object({
  email: z.string().trim().min(1).max(320),
  name: z.string().optional(),
  /** Extra CSV columns, used for {{merge_tags}}. */
  vars: z.record(z.string()).optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const MAX_LEADS_PER_CAMPAIGN = 10_000;

export const CreateCampaignInputSchema = z.object({
  subject: z.string().trim().min(1, 'Subject is required').max(300),
  body: z.string().trim().min(1, 'Body is required').max(50_000),
  leads: z.array(LeadSchema).min(1, 'Upload at least one lead').max(MAX_LEADS_PER_CAMPAIGN),
  /** ISO timestamp — when the first email goes out. */
  startAt: z.string().datetime({ offset: true }),
  /** Spacing between consecutive emails of this campaign, in seconds. */
  delayBetweenSeconds: z.coerce.number().int().min(0).max(86_400),
  /** Campaign-level cap per rate window (hour by default). */
  hourlyLimit: z.coerce.number().int().min(1).max(10_000),
  /** Optional subset of senders; default = all active senders, round-robin. */
  senderIds: z.array(z.string()).optional(),
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export const CreateCampaignResponseSchema = z.object({
  campaignId: z.string(),
  accepted: z.number(),
  invalid: z.array(z.string()),
  duplicates: z.number(),
  estimatedFinishAt: z.string(),
});
export type CreateCampaignResponse = z.infer<typeof CreateCampaignResponseSchema>;

/** Pragmatic address check (same regex on client and server so counts match). */
export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
export const isValidEmail = (s: string) => s.length <= 320 && EMAIL_RE.test(s);

/** {{merge_tags}} → value; unknown tags render empty. `escape` is applied to substituted values only. */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string | undefined>,
  escape: (v: string) => string = (v) => v,
): string {
  const lower = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return tpl.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => escape(lower[key.toLowerCase()] ?? ''));
}
