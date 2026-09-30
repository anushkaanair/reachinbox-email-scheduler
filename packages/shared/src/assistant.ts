import { z } from 'zod';

/**
 * "Ask Inbox" — the in-app assistant. The API is UI-agnostic: it returns plain text plus typed
 * blocks (stats, tables, lists, timelines, bars) and optional follow-ups, and any interface
 * (command palette, side panel, floating window) can render them.
 */

export const AssistantContextSchema = z.object({
  /** The campaign / email the conversation is currently about, so "pause it" works. */
  campaignId: z.string().max(64).optional(),
  emailId: z.string().max(64).optional(),
});
export type AssistantContext = z.infer<typeof AssistantContextSchema>;

export const AssistantRequestSchema = z.object({
  message: z.string().trim().min(1, 'Type a question or a command').max(500),
  context: AssistantContextSchema.optional(),
  /** IANA zone used for "today" and for times in the answer. Defaults to UTC. */
  timezone: z.string().max(64).optional(),
});
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;

const Tone = z.enum(['neutral', 'success', 'warning', 'danger', 'info']);
export type AssistantTone = z.infer<typeof Tone>;

export const AssistantBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stats'),
    items: z.array(z.object({ label: z.string(), value: z.string(), tone: Tone.optional(), hint: z.string().optional() })),
  }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    /** Where "see all" should go in the app. */
    link: z.object({ label: z.string(), to: z.string() }).optional(),
  }),
  z.object({
    type: z.literal('list'),
    items: z.array(z.object({ title: z.string(), subtitle: z.string().optional(), to: z.string().optional(), tone: Tone.optional() })),
  }),
  z.object({
    type: z.literal('timeline'),
    items: z.array(z.object({ label: z.string(), at: z.string(), detail: z.string().optional(), tone: Tone.optional() })),
  }),
  z.object({
    type: z.literal('bars'),
    items: z.array(z.object({ label: z.string(), value: z.number(), max: z.number(), hint: z.string().optional(), tone: Tone.optional() })),
  }),
]);
export type AssistantBlock = z.infer<typeof AssistantBlockSchema>;

/** A change the assistant proposes and will only carry out after an explicit Confirm. */
export const PendingActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  title: z.string(),
  description: z.string(),
  /** Destructive or hard to undo → the UI should make the confirm step more prominent. */
  danger: z.boolean(),
  confirmLabel: z.string(),
  expiresAt: z.string(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const AssistantReplySchema = z.object({
  /** Which rule matched — handy for tests and debugging; never shown as an answer. */
  intent: z.string(),
  text: z.string(),
  blocks: z.array(AssistantBlockSchema),
  pending: PendingActionSchema.optional(),
  /** Open a page in the app (e.g. "open analytics"). */
  navigate: z.object({ to: z.string(), label: z.string(), external: z.boolean().optional() }).optional(),
  /** Direct download link (CSV export). */
  download: z.object({ url: z.string(), label: z.string() }).optional(),
  /** Clickable follow-ups; each is just another message to send. */
  suggestions: z.array(z.string()),
  context: AssistantContextSchema.optional(),
  /** `offline` = rule-based (no external AI service). */
  mode: z.literal('offline'),
});
export type AssistantReply = z.infer<typeof AssistantReplySchema>;

export const AssistantActionRefSchema = z.object({ id: z.string().min(8).max(64) });
