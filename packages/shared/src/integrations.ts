import { z } from 'zod';
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
