import { z } from 'zod';
import { SendWindowSchema } from './sendWindow.js';
import { spintaxError } from './spintax.js';
import { EmailRowSchema, EmailTabSchema } from './email.js';

// ── Search (Elasticsearch) ────────────────────────────────────────────────────

/** Highlight markers wrap matched text. Plain control characters, never HTML, so rendering is XSS-safe. */
export const HL_OPEN = '\u0001';
export const HL_CLOSE = '\u0002';

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  status: EmailTabSchema.optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  size: z.coerce.number().int().min(1).max(100).default(25),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const SearchHitSchema = EmailRowSchema.extend({
  /** Field → highlighted fragments (with HL_OPEN/HL_CLOSE markers). */
  highlights: z.record(z.array(z.string())),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResponseSchema = z.object({
  items: z.array(SearchHitSchema),
  total: z.number(),
  tookMs: z.number(),
  /** true when nothing matched exactly and these are typo-tolerant (fuzzy) matches. */
  approximate: z.boolean(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

// ── Slack ─────────────────────────────────────────────────────────────────────

export const SlackStatusSchema = z.object({
  /** Server has SLACK_CLIENT_ID/SECRET/REDIRECT_URI. */
  configured: z.boolean(),
  connected: z.boolean(),
  /** false when Slack rejected the stored webhook (revoked/uninstalled) → user must reconnect. */
  valid: z.boolean(),
  teamName: z.string().nullable(),
  channelName: z.string().nullable(),
  connectedAt: z.string().nullable(),
});
export type SlackStatus = z.infer<typeof SlackStatusSchema>;

// ── Pre-flight (compose-time report + forecast) ───────────────────────────────

export const PreflightInputSchema = z.object({
  /** Raw addresses from the uploaded file; the server normalises and de-duplicates them. */
  emails: z.array(z.string().max(320)).min(1).max(10_000),
  startAt: z.string().datetime({ offset: true }),
  delayBetweenSeconds: z.coerce.number().int().min(0).max(86_400),
  hourlyLimit: z.coerce.number().int().min(1).max(10_000),
  senderIds: z.array(z.string()).optional(),
  sendWindow: SendWindowSchema.optional(),
  skipRecentDays: z.coerce.number().int().min(0).max(365).default(0),
  jitterPercent: z.coerce.number().int().min(0).max(50).default(0),
});
export type PreflightInput = z.infer<typeof PreflightInputSchema>;

export const ForecastWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  /** Emails that will go out in this window. */
  count: z.number(),
  /** Emails still waiting after this window (carried to the next). */
  carried: z.number(),
  /** true when the window's limit is what stopped more emails going out. */
  limited: z.boolean(),
});
export type ForecastWindow = z.infer<typeof ForecastWindowSchema>;

export const PreflightResponseSchema = z.object({
  valid: z.number(),
  invalid: z.number(),
  duplicates: z.number(),
  suppressed: z.number(),
  recentlyEmailed: z.number(),
  sendable: z.number(),
  windowSeconds: z.number(),
  forecast: z.object({
    firstSendAt: z.string().nullable(),
    finishAt: z.string().nullable(),
    windows: z.array(ForecastWindowSchema),
    windowsTotal: z.number(),
    /** More windows than are listed (or the run is longer than we simulate). */
    truncated: z.boolean(),
  }),
});
export type PreflightResponse = z.infer<typeof PreflightResponseSchema>;

// ── Test send ────────────────────────────────────────────────────────────────

const validSpintax = (v: string, ctx: z.RefinementCtx) => {
  const err = spintaxError(v);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
};

export const TestSendInputSchema = z.object({
  subject: z.string().trim().min(1).max(300).superRefine(validSpintax),
  body: z.string().trim().min(1).max(50_000).superRefine(validSpintax),
  bodyFormat: z.enum(['TEXT', 'HTML']).default('TEXT'),
  senderId: z.string().optional(),
  /** Values used to render the merge tags (usually the lead being previewed). */
  sample: z
    .object({ email: z.string().max(320), name: z.string().optional(), vars: z.record(z.string()).optional() })
    .optional(),
});
export type TestSendInput = z.infer<typeof TestSendInputSchema>;

export const TestSendResponseSchema = z.object({
  to: z.string(),
  subject: z.string(),
  previewUrl: z.string().nullable(),
});
export type TestSendResponse = z.infer<typeof TestSendResponseSchema>;

// ── Do-not-contact list ──────────────────────────────────────────────────────

export const SuppressionSchema = z.object({
  id: z.string(),
  email: z.string(),
  createdAt: z.string(),
});
export type Suppression = z.infer<typeof SuppressionSchema>;

export const SuppressionListSchema = z.object({
  items: z.array(SuppressionSchema),
  total: z.number(),
});
export type SuppressionList = z.infer<typeof SuppressionListSchema>;

export const AddSuppressionsInputSchema = z.object({ emails: z.array(z.string().max(320)).min(1).max(10_000) });
export const AddSuppressionsResponseSchema = z.object({
  added: z.number(),
  alreadyListed: z.number(),
  invalid: z.array(z.string()),
});
export type AddSuppressionsResponse = z.infer<typeof AddSuppressionsResponseSchema>;
