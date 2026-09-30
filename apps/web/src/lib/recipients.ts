import { MAX_LEADS_PER_CAMPAIGN, isValidEmail, type Lead } from '@ri/shared';
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, parseLeads } from './csv';

/** Everyone the campaign will go to, from typed addresses and uploaded lists together. */
export type Recipients = {
  leads: Lead[];
  /** Merge-tag names available from uploaded columns (always includes email and name). */
  tags: string[];
  /** Entries from uploads that looked like addresses but weren't valid. */
  invalid: string[];
  duplicates: number;
  truncated: boolean;
  /** Name of the last uploaded file, for the summary line. */
  fileName: string | null;
};

export const EMPTY_RECIPIENTS: Recipients = { leads: [], tags: ['email', 'name'], invalid: [], duplicates: 0, truncated: false, fileName: null };

const clean = (s: string) => s.trim().replace(/^[<"'(]+|[>"'),.;]+$/g, '').toLowerCase();

/** Merge new leads in, first occurrence wins; counts what was dropped. */
function merge(cur: Recipients, incoming: Lead[]): { leads: Lead[]; duplicates: number; truncated: boolean } {
  const seen = new Set(cur.leads.map((l) => l.email));
  const leads = [...cur.leads];
  let duplicates = 0;
  let truncated = false;
  for (const l of incoming) {
    if (seen.has(l.email)) duplicates++;
    else if (leads.length >= MAX_LEADS_PER_CAMPAIGN) truncated = true;
    else {
      seen.add(l.email);
      leads.push(l);
    }
  }
  return { leads, duplicates, truncated };
}

/** Typed or pasted addresses, separated by spaces, commas, semicolons or new lines. Returns what was refused. */
export function addTyped(cur: Recipients, text: string): { next: Recipients; rejected: string[] } {
  const tokens = text.split(/[\s,;]+/).map(clean).filter(Boolean);
  const rejected = tokens.filter((t) => !isValidEmail(t));
  const valid = tokens.filter((t) => isValidEmail(t)).map((email) => ({ email }));
  const m = merge(cur, valid);
  return { next: { ...cur, leads: m.leads, truncated: cur.truncated || m.truncated }, rejected };
}

export type FileResult = { next: Recipients } | { error: string };

/** Reads a .csv/.txt, parses it in the browser, and merges its addresses into the current list. */
export async function addFile(cur: Recipients, file: File): Promise<FileResult> {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) return { error: 'Please upload a .csv or .txt file.' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: 'File is larger than 5 MB.' };
  let parsed;
  try {
    parsed = parseLeads(await file.text());
  } catch {
    return { error: 'Could not read that file.' };
  }
  if (parsed.leads.length === 0) return { error: `No valid email addresses found in ${file.name}.` };
  const m = merge(cur, parsed.leads);
  return {
    next: {
      leads: m.leads,
      tags: [...new Set([...cur.tags, ...parsed.tags])],
      invalid: [...cur.invalid, ...parsed.invalid],
      duplicates: cur.duplicates + parsed.duplicates + m.duplicates,
      truncated: cur.truncated || parsed.truncated || m.truncated,
      fileName: file.name,
    },
  };
}

export const removeLead = (cur: Recipients, email: string): Recipients => ({ ...cur, leads: cur.leads.filter((l) => l.email !== email) });
