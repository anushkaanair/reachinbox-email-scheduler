import { z } from 'zod';
import { LeadSchema, MAX_LEADS_PER_CAMPAIGN, isValidEmail } from './campaign.js';

/**
 * Saved lead lists and what "verified" means here. We check what can be checked honestly without contacting the
 * mailbox: the address format, whether the domain can receive mail at all (MX, or an A record as a fallback),
 * throwaway domains, role addresses (info@…) and common typos. We never probe the mailbox itself; that is
 * unreliable and can damage a sender's reputation.
 */
export const LEAD_STATUSES = ['VALID', 'RISKY', 'UNDELIVERABLE', 'UNKNOWN'] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  VALID: 'Valid domain',
  RISKY: 'Risky',
  UNDELIVERABLE: 'Undeliverable',
  UNKNOWN: 'Couldn’t check',
};

export const LEAD_REASONS = ['no_mail_server', 'rejects_mail', 'disposable', 'role', 'typo', 'dns_unavailable'] as const;
export type LeadReason = (typeof LEAD_REASONS)[number];

export const LEAD_REASON_LABEL: Record<LeadReason, string> = {
  no_mail_server: 'The domain has no mail server',
  rejects_mail: 'The domain says it accepts no mail',
  disposable: 'Throwaway email domain',
  role: 'Shared role address (nobody in particular reads it)',
  typo: 'Looks like a typo in the domain',
  dns_unavailable: 'The domain lookup timed out; try again',
};

export const MAX_LISTS = 20;
export const MAX_LEADS_PER_USER = 50_000;

/** A sample of well-known disposable providers. A heuristic, not a complete list. */
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'throwawaymail.com', 'yopmail.com', 'yopmail.fr', 'trashmail.com', 'trashmail.net',
  'getnada.com', 'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com',
  'mailnesia.com', 'tempinbox.com', 'mytemp.email', 'burnermail.io', 'moakt.com', 'tempail.com', 'discard.email', 'spambog.com',
]);

/** Local parts that point at a team or a robot rather than a person. */
export const ROLE_LOCAL_PARTS = new Set([
  'info', 'admin', 'administrator', 'support', 'help', 'sales', 'contact', 'hello', 'office', 'team', 'billing', 'accounts', 'accounting',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'postmaster', 'webmaster', 'abuse', 'mail', 'marketing', 'hr', 'jobs', 'careers', 'press', 'legal',
]);

/** Frequent misspellings of big providers → the domain people meant. */
export const TYPO_DOMAINS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmai.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yhoo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'homail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'outllok.com': 'outlook.com',
  'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com',
};

export type StaticCheck = { status?: LeadStatus; reason?: LeadReason; suggestion?: string };

/** What can be said from the address alone (no network): format, role, disposable, typo. */
export function staticCheck(email: string): StaticCheck {
  const e = email.trim().toLowerCase();
  if (!isValidEmail(e)) return { status: 'UNDELIVERABLE', reason: 'no_mail_server' };
  const at = e.lastIndexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (DISPOSABLE_DOMAINS.has(domain)) return { status: 'RISKY', reason: 'disposable' };
  const fix = TYPO_DOMAINS[domain];
  if (fix) return { status: 'RISKY', reason: 'typo', suggestion: `${local}@${fix}` };
  if (ROLE_LOCAL_PARTS.has(local.split('+')[0]!)) return { status: 'RISKY', reason: 'role' };
  return {};
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** What the DNS lookup of a domain found. */
export type DomainMail = 'accepts' | 'none' | 'null_mx' | 'unavailable';

/** Combine the static findings with the domain lookup. Undeliverable beats risky beats valid; a failed lookup is "unknown". */
export function classifyLead(email: string, mail: DomainMail): { status: LeadStatus; reason: LeadReason | null; suggestion: string | null } {
  if (mail === 'none') return { status: 'UNDELIVERABLE', reason: 'no_mail_server', suggestion: staticCheck(email).suggestion ?? null };
  if (mail === 'null_mx') return { status: 'UNDELIVERABLE', reason: 'rejects_mail', suggestion: null };
  const s = staticCheck(email);
  if (s.status === 'UNDELIVERABLE') return { status: 'UNDELIVERABLE', reason: s.reason ?? 'no_mail_server', suggestion: null };
  if (s.status === 'RISKY') return { status: 'RISKY', reason: s.reason ?? null, suggestion: s.suggestion ?? null };
  if (mail === 'unavailable') return { status: 'UNKNOWN', reason: 'dns_unavailable', suggestion: null };
  return { status: 'VALID', reason: null, suggestion: null };
}

// ── API shapes ───────────────────────────────────────────────────────────────

export const LeadCountsSchema = z.object({ valid: z.number(), risky: z.number(), undeliverable: z.number(), unknown: z.number(), unchecked: z.number() });
export type LeadCounts = z.infer<typeof LeadCountsSchema>;

export const LeadListSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  total: z.number(),
  counts: LeadCountsSchema,
  updatedAt: z.string(),
});
export type LeadListSummary = z.infer<typeof LeadListSummarySchema>;

export const CreateLeadListSchema = z.object({
  name: z.string().trim().min(1, 'Give the list a name').max(80),
  leads: z.array(LeadSchema).min(1, 'Add at least one address').max(MAX_LEADS_PER_CAMPAIGN),
});
export type CreateLeadList = z.infer<typeof CreateLeadListSchema>;

export const LeadRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  status: LeadStatusSchema.nullable(),
  reason: z.enum(LEAD_REASONS).nullable(),
  suggestion: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type LeadRow = z.infer<typeof LeadRowSchema>;

export const LeadPageSchema = z.object({ items: z.array(LeadRowSchema), nextCursor: z.string().nullable(), total: z.number() });
export type LeadPage = z.infer<typeof LeadPageSchema>;

export const VerifyResultSchema = z.object({ checked: z.number(), remaining: z.number(), counts: LeadCountsSchema });
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
