import Papa from 'papaparse';
import { MAX_LEADS_PER_CAMPAIGN, isValidEmail, type Lead } from '@ri/shared';

export type ParsedLeads = {
  leads: Lead[];
  /** Raw values that looked like an address but failed validation. */
  invalid: string[];
  duplicates: number;
  /** 'columns' = CSV with an email header; 'scan' = addresses extracted from free text / headerless CSV. */
  mode: 'columns' | 'scan';
  /** Merge-tag names available from CSV columns (always includes email). */
  tags: string[];
  truncated: boolean;
};

const EMAIL_HEADER = /^(e-?mail|email ?address|e-?mail ?id)$/i;
const NAME_HEADER = /^(name|full ?name|first ?name|contact ?name)$/i;
const tagKey = (h: string) => h.trim().toLowerCase().replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
const clean = (s: string) => s.trim().replace(/^[<"'(]+|[>"'),.;]+$/g, '');

/**
 * Parses an uploaded lead list.
 *  - CSV with a header containing an email column → one lead per row, other columns become {{tags}}.
 *  - Anything else (.txt, headerless CSV, pasted text) → every address-like token is extracted.
 * Addresses are lowercased and deduplicated; the same rules run again on the server.
 */
export function parseLeads(text: string): ParsedLeads {
  const rows = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' }).data;
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const emailIdx = header.findIndex((h) => EMAIL_HEADER.test(h));

  const seen = new Set<string>();
  const leads: Lead[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  let truncated = false;

  const add = (raw: string, name?: string, vars?: Record<string, string>) => {
    const email = clean(raw).toLowerCase();
    if (!email) return;
    if (!isValidEmail(email)) return void invalid.push(raw.trim());
    if (seen.has(email)) return void duplicates++;
    if (leads.length >= MAX_LEADS_PER_CAMPAIGN) return void (truncated = true);
    seen.add(email);
    leads.push({ email, ...(name ? { name } : {}), ...(vars && Object.keys(vars).length ? { vars } : {}) });
  };

  if (emailIdx >= 0) {
    const nameIdx = header.findIndex((h) => NAME_HEADER.test(h));
    const varCols = header
      .map((h, i) => ({ i, key: tagKey(h) }))
      .filter(({ i, key }) => i !== emailIdx && i !== nameIdx && key);
    for (const row of rows.slice(1)) {
      const vars: Record<string, string> = {};
      for (const { i, key } of varCols) if (row[i]?.trim()) vars[key] = row[i]!.trim();
      add(row[emailIdx] ?? '', nameIdx >= 0 ? row[nameIdx]?.trim() : undefined, vars);
    }
    const tags = ['email', ...(nameIdx >= 0 ? ['name'] : []), ...varCols.map((c) => c.key)];
    return { leads, invalid, duplicates, mode: 'columns', tags, truncated };
  }

  for (const row of rows)
    for (const cell of row)
      for (const token of cell.split(/[\s,;]+/)) if (token.includes('@')) add(token);
  return { leads, invalid, duplicates, mode: 'scan', tags: ['email'], truncated };
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['.csv', '.txt'];
