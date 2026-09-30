import { z } from 'zod';
import { SendWindowSchema } from './sendWindow.js';
import { spintaxError } from './spintax.js';

/** Raw lead as parsed from CSV — the server validates addresses and reports invalid ones back. */
export const LeadSchema = z.object({
  email: z.string().trim().min(1).max(320),
  name: z.string().optional(),
  /** Extra CSV columns, used for {{merge_tags}}. */
  vars: z.record(z.string()).optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const MAX_LEADS_PER_CAMPAIGN = 10_000;

/** Subject/body: required text whose {spin|tax} (if any) must be well-formed. */
const templateText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max)
    .superRefine((v, ctx) => {
      const err = spintaxError(v);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    });

/** Randomise the gap between emails by up to ±N% so the cadence looks human (0 = exact). */
export const JitterPercentSchema = z.coerce.number().int().min(0).max(50).default(0);

export const CreateCampaignInputSchema = z.object({
  subject: templateText('Subject', 300),
  body: templateText('Body', 50_000),
  leads: z.array(LeadSchema).min(1, 'Upload at least one lead').max(MAX_LEADS_PER_CAMPAIGN),
  /** ISO timestamp — when the first email goes out. */
  startAt: z.string().datetime({ offset: true }),
  /** Spacing between consecutive emails of this campaign, in seconds. */
  delayBetweenSeconds: z.coerce.number().int().min(0).max(86_400),
  /** Campaign-level cap per rate window (hour by default). */
  hourlyLimit: z.coerce.number().int().min(1).max(10_000),
  /** Optional subset of senders; default = all active senders, round-robin. */
  senderIds: z.array(z.string()).optional(),
  /** Only send during these local business hours (emails outside roll to the next opening). */
  sendWindow: SendWindowSchema.optional(),
  /** Skip anyone this user already emailed (or scheduled) within the last N days; 0 = off. */
  skipRecentDays: z.coerce.number().int().min(0).max(365).default(0),
  jitterPercent: JitterPercentSchema,
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>;

export const CreateCampaignResponseSchema = z.object({
  campaignId: z.string(),
  accepted: z.number(),
  invalid: z.array(z.string()),
  duplicates: z.number(),
  /** Leads on the user's do-not-contact list. */
  suppressed: z.number(),
  /** Leads skipped by the "recently emailed" guard. */
  recentlyEmailed: z.number(),
  firstSendAt: z.string(),
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
