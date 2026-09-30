import Papa from 'papaparse';
import { IMPORT_FIELDS, type ImportFieldKey, type ImportRow, type SenderDetail } from '@ri/shared';

export const FILTERS = [
  { key: 'errors', label: 'Needs attention' },
  { key: 'warming', label: 'Warm-up on' },
  { key: 'google', label: 'Google' },
  { key: 'outlook', label: 'Microsoft' },
  { key: 'custom', label: 'Custom SMTP' },
  { key: 'noDns', label: 'DNS not checked' },
] as const;
export type FilterKey = (typeof FILTERS)[number]['key'];

const MATCH: Record<FilterKey, (s: SenderDetail) => boolean> = {
  errors: (s) => s.attention !== null,
  warming: (s) => s.warmup.enabled && !s.warmup.complete,
  google: (s) => s.provider === 'GOOGLE',
  outlook: (s) => s.provider === 'OUTLOOK',
  custom: (s) => s.provider === 'CUSTOM' || s.provider === 'ETHEREAL',
  noDns: (s) => s.dns === null,
};

/** Filters combine with AND (narrowing), like the multi-select filters on the reference product. */
export function filterAccounts(list: SenderDetail[], filters: ReadonlySet<FilterKey>, query: string, tags: ReadonlySet<string> = new Set()): SenderDetail[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (s) =>
      [...filters].every((f) => MATCH[f](s)) &&
      [...tags].every((t) => s.tags.includes(t)) &&
      (!q || s.email.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q) || s.tags.some((t) => t.includes(q))),
  );
}

export const accountSummary = (list: SenderDetail[]) => ({
  total: list.length,
  attention: list.filter((s) => s.attention !== null).length,
  warming: list.filter(MATCH.warming).length,
});

export const allTags = (list: SenderDetail[]) => [...new Set(list.flatMap((s) => s.tags))].sort();

export type ParsedAccountsCsv = { headers: string[]; rows: Record<string, string>[] };

/** Reads an uploaded accounts CSV (header row required). Empty lines and a BOM are ignored. */
export function parseAccountsCsv(text: string): ParsedAccountsCsv {
  const res = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' });
  const [head, ...body] = res.data;
  const headers = (head ?? []).map((h) => h.trim());
  const rows = body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { headers, rows };
}

/** Apply a column → field mapping; unmapped columns are dropped (the template's IMAP columns, for example). */
export function applyMapping(rows: Record<string, string>[], mapping: Record<string, ImportFieldKey | null>): ImportRow[] {
  return rows.map((r) => {
    const out: ImportRow = {};
    for (const [col, field] of Object.entries(mapping)) if (field && r[col] !== undefined) out[field] = r[col];
    return out;
  });
}

/** Required fields nobody is mapped to — blocks the import with a clear message. */
export const missingRequired = (mapping: Record<string, ImportFieldKey | null>) => {
  const mapped = new Set(Object.values(mapping));
  return IMPORT_FIELDS.filter((f) => f.required && !mapped.has(f.key)).map((f) => f.label);
};

/** The sample file offered for download: the columns we read, plus an example row. */
export const SAMPLE_CSV =
  'Email,First Name,Last Name,SMTP Username,SMTP Password,SMTP Host,SMTP Port,Daily Limit,Warmup Enabled,Warmup Limit,Warmup Increment,Tags\r\n' +
  'sales@example.com,Sam,Rivera,sales@example.com,app-password-here,smtp.example.com,587,40,TRUE,30,2,outreach;eu\r\n';
