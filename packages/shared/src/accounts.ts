import { z } from 'zod';

/**
 * Connecting and configuring sending accounts: providers and their SMTP presets, create / settings /
 * bulk / CSV-import shapes, and the DNS report. Pure and shared, so the API validates exactly what the
 * UI previews.
 */

export const SENDER_PROVIDERS = ['GOOGLE', 'OUTLOOK', 'CUSTOM', 'ETHEREAL'] as const;
export const SenderProviderSchema = z.enum(SENDER_PROVIDERS);
export type SenderProvider = z.infer<typeof SenderProviderSchema>;

export const PROVIDER_LABEL: Record<SenderProvider, string> = {
  GOOGLE: 'Google / Gmail',
  OUTLOOK: 'Microsoft / Outlook',
  CUSTOM: 'Custom SMTP',
  ETHEREAL: 'Ethereal (test)',
};

/** SMTP defaults per provider. Custom providers enter their own host. */
export const SMTP_PRESETS: Record<SenderProvider, { host: string; port: number } | null> = {
  GOOGLE: { host: 'smtp.gmail.com', port: 587 },
  OUTLOOK: { host: 'smtp.office365.com', port: 587 },
  ETHEREAL: { host: 'smtp.ethereal.email', port: 587 },
  CUSTOM: null,
};

/** Guess the provider from an address / SMTP host so CSV rows and the form can pre-fill sensibly. */
export function guessProvider(email: string, smtpHost?: string): SenderProvider {
  const host = (smtpHost ?? '').toLowerCase();
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (host.includes('gmail') || host.includes('google') || domain === 'gmail.com' || domain === 'googlemail.com') return 'GOOGLE';
  if (host.includes('office365') || host.includes('outlook') || ['outlook.com', 'hotmail.com', 'live.com'].includes(domain)) return 'OUTLOOK';
  if (host.includes('ethereal') || domain === 'ethereal.email') return 'ETHEREAL';
  return 'CUSTOM';
}

const port = z.coerce.number().int().min(1).max(65_535);
const tag = z.string().trim().min(1).max(24);
export const TagsSchema = z.array(tag).max(10).transform((t) => [...new Set(t.map((x) => x.toLowerCase()))]);

export const SenderCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().max(60).optional().default(''),
    provider: SenderProviderSchema.optional(),
    smtpHost: z.string().trim().min(1).max(255).optional(),
    smtpPort: port.optional(),
    smtpUser: z.string().trim().min(1).max(255).optional(),
    /** Mailbox password, or an app password for Google. Stored encrypted; never returned. */
    smtpPass: z.string().min(1).max(512),
    dailyLimit: z.coerce.number().int().min(1).max(10_000).optional(),
    tags: TagsSchema.optional(),
    /** Log in to the SMTP server before saving (default). Turn off only for offline setups. */
    verify: z.boolean().optional().default(true),
  })
  .superRefine((v, ctx) => {
    const provider = v.provider ?? guessProvider(v.email, v.smtpHost);
    if (!v.smtpHost && !SMTP_PRESETS[provider]) ctx.addIssue({ code: 'custom', path: ['smtpHost'], message: 'SMTP host is required for a custom provider' });
  });
export type SenderCreate = z.infer<typeof SenderCreateSchema>;
export type SenderCreateInput = z.input<typeof SenderCreateSchema>;

/** Everything here is optional; `null` clears a setting back to its default. */
export const SenderSettingsSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  /** Campaign emails per day from this account (no limit when null). */
  dailyLimit: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  /** Per-account override of the hourly limit (null = the server default). */
  hourlyLimit: z.coerce.number().int().min(1).max(10_000).nullable().optional(),
  /** Minimum gap between two sends from this account. Can only raise the server-wide floor. */
  minDelaySeconds: z.coerce.number().int().min(0).max(3600).nullable().optional(),
  signature: z.string().max(2000).nullable().optional(),
  replyTo: z.string().trim().toLowerCase().email().nullable().optional(),
  tags: TagsSchema.optional(),
});
export type SenderSettings = z.infer<typeof SenderSettingsSchema>;

/** Fix a disconnected account: new password (and optionally a corrected host/port/user). */
export const ReconnectSchema = z.object({
  smtpPass: z.string().min(1).max(512),
  smtpHost: z.string().trim().min(1).max(255).optional(),
  smtpPort: port.optional(),
  smtpUser: z.string().trim().min(1).max(255).optional(),
});
export type Reconnect = z.infer<typeof ReconnectSchema>;

export const BulkActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable_warmup'), ids: z.array(z.string()).min(1).max(500) }),
  z.object({ action: z.literal('pause_warmup'), ids: z.array(z.string()).min(1).max(500) }),
  z.object({ action: z.literal('delete'), ids: z.array(z.string()).min(1).max(500) }),
  z.object({ action: z.literal('add_tags'), ids: z.array(z.string()).min(1).max(500), tags: TagsSchema.refine((t) => t.length > 0, 'Add at least one tag') }),
  z.object({ action: z.literal('edit_settings'), ids: z.array(z.string()).min(1).max(500), settings: SenderSettingsSchema.omit({ tags: true, firstName: true, lastName: true }) }),
]);
export type BulkAction = z.infer<typeof BulkActionSchema>;

export const TestEmailSchema = z.object({ to: z.string().trim().toLowerCase().email() });

// ── CSV import ───────────────────────────────────────────────────────────────

/** Fields a CSV column can be mapped to. The ReachInbox template's other columns are accepted and ignored. */
export const IMPORT_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'firstName', label: 'First Name', required: true },
  { key: 'lastName', label: 'Last Name', required: false },
  { key: 'smtpUser', label: 'SMTP Username', required: false },
  { key: 'smtpPass', label: 'SMTP Password', required: true },
  { key: 'smtpHost', label: 'SMTP Host', required: false },
  { key: 'smtpPort', label: 'SMTP Port', required: false },
  { key: 'dailyLimit', label: 'Daily Limit', required: false },
  { key: 'warmupEnabled', label: 'Warmup Enabled', required: false },
  { key: 'warmupLimit', label: 'Warmup Limit', required: false },
  { key: 'warmupIncrement', label: 'Warmup Increment', required: false },
  { key: 'tags', label: 'Tags', required: false },
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HEADER_ALIASES: Record<string, ImportFieldKey> = {
  email: 'email', emailaddress: 'email', mailbox: 'email',
  firstname: 'firstName', first: 'firstName', name: 'firstName',
  lastname: 'lastName', last: 'lastName', surname: 'lastName',
  smtpusername: 'smtpUser', smtpuser: 'smtpUser', username: 'smtpUser',
  smtppassword: 'smtpPass', smtppass: 'smtpPass', password: 'smtpPass', apppassword: 'smtpPass',
  smtphost: 'smtpHost', host: 'smtpHost', smtpserver: 'smtpHost',
  smtpport: 'smtpPort', port: 'smtpPort',
  dailylimit: 'dailyLimit', dailysendlimit: 'dailyLimit', dailyemaillimit: 'dailyLimit',
  warmupenabled: 'warmupEnabled', warmup: 'warmupEnabled',
  warmuplimit: 'warmupLimit', warmuptarget: 'warmupLimit',
  warmupincrement: 'warmupIncrement',
  tags: 'tags', tag: 'tags',
};

/** Suggest a column → field mapping from header names (the user can correct it before importing). */
export function suggestMapping(headers: string[]): Record<string, ImportFieldKey | null> {
  const used = new Set<ImportFieldKey>();
  const out: Record<string, ImportFieldKey | null> = {};
  for (const h of headers) {
    const key = HEADER_ALIASES[squash(h)] ?? null;
    out[h] = key && !used.has(key) ? key : null;
    if (out[h]) used.add(out[h]!);
  }
  return out;
}

const truthy = (v: string | undefined) => /^(true|yes|y|1|on)$/i.test((v ?? '').trim());

export type ImportRow = Partial<Record<ImportFieldKey, string>>;

export const ImportRequestSchema = z.object({
  rows: z.array(z.record(z.string(), z.string().max(1000))).min(1).max(200),
  /** Log in to each SMTP server before saving. */
  verify: z.boolean().optional().default(true),
});

export type ImportRowResult =
  | { row: number; email: string; status: 'created' | 'skipped'; message?: string }
  | { row: number; email: string; status: 'failed'; message: string };

export type ImportReport = { created: number; skipped: number; failed: number; results: ImportRowResult[] };

/** Turn one mapped CSV row into a create request (and the optional warm-up it asks for). */
export function rowToCreate(row: ImportRow): { create: SenderCreate; warmup?: { enabled: boolean; target?: number; increment?: number } } | { error: string } {
  const host = row.smtpHost?.trim() || undefined;
  const parsed = SenderCreateSchema.safeParse({
    email: row.email?.trim(),
    firstName: row.firstName?.trim(),
    lastName: row.lastName?.trim() || '',
    smtpHost: host,
    smtpPort: row.smtpPort?.trim() || undefined,
    smtpUser: row.smtpUser?.trim() || undefined,
    smtpPass: row.smtpPass,
    dailyLimit: row.dailyLimit?.trim() || undefined,
    tags: row.tags ? row.tags.split(/[;|,]/).map((t) => t.trim()).filter(Boolean) : undefined,
  });
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return { error: `${i.path.join('.') || 'row'}: ${i.message}` };
  }
  const enabled = truthy(row.warmupEnabled);
  const target = row.warmupLimit?.trim() ? Number(row.warmupLimit) : undefined;
  const increment = row.warmupIncrement?.trim() ? Number(row.warmupIncrement) : undefined;
  if (enabled && ((target !== undefined && !(Number.isInteger(target) && target >= 1)) || (increment !== undefined && !(Number.isInteger(increment) && increment >= 1)))) {
    return { error: 'warmup: limit and increment must be whole numbers ≥ 1' };
  }
  return { create: parsed.data, warmup: enabled ? { enabled, target, increment } : undefined };
}

// ── DNS check ────────────────────────────────────────────────────────────────

export type DnsStatus = 'pass' | 'fail' | 'unknown';
export const DnsRecordSchema = z.object({ status: z.enum(['pass', 'fail', 'unknown']), detail: z.string() });
export const DnsReportSchema = z.object({
  domain: z.string(),
  checkedAt: z.string(),
  spf: DnsRecordSchema,
  dkim: DnsRecordSchema,
  dmarc: DnsRecordSchema,
  mx: DnsRecordSchema,
});
export type DnsReport = z.infer<typeof DnsReportSchema>;

export function dnsSummary(r: DnsReport): { pass: number; fail: number } {
  const all = [r.spf, r.dkim, r.dmarc, r.mx];
  return { pass: all.filter((x) => x.status === 'pass').length, fail: all.filter((x) => x.status === 'fail').length };
}
