import type { Lead } from '@ri/shared';

const TAG_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Values a lead can fill in: email, name, plus every extra CSV column (keys lower-cased). */
export function leadVars(lead: Lead): Record<string, string> {
  const vars: Record<string, string> = { email: lead.email, name: lead.name ?? '' };
  for (const [k, v] of Object.entries(lead.vars ?? {})) vars[k.toLowerCase()] = v;
  return vars;
}

/** Unique, lower-cased merge tags used across the given templates, in order of first appearance. */
export function extractTags(...templates: string[]): string[] {
  const seen = new Set<string>();
  for (const tpl of templates) for (const m of tpl.matchAll(TAG_RE)) seen.add(m[1]!.toLowerCase());
  return [...seen];
}

export type TagGap = {
  tag: string;
  /** Leads for whom this tag renders empty. */
  missing: number;
  /** true when NO lead has it — usually a typo or a column that isn't in the file. */
  unknown: boolean;
  /** Index of the first lead with a blank value, to jump the preview there. */
  firstIndex: number;
};

/** For each tag in use, how many leads would get a blank. Tags nobody is missing are omitted. */
export function tagGaps(leads: Lead[], tags: string[]): TagGap[] {
  const out: TagGap[] = [];
  for (const tag of tags) {
    let missing = 0;
    let firstIndex = -1;
    leads.forEach((lead, i) => {
      if (!leadVars(lead)[tag]?.trim()) {
        missing++;
        if (firstIndex < 0) firstIndex = i;
      }
    });
    if (missing > 0) out.push({ tag, missing, unknown: missing === leads.length, firstIndex });
  }
  return out;
}

export type Segment = { text: string; kind: 'text' | 'value' | 'missing'; tag?: string };

/** Splits a template into plain text and filled/blank merge-tag segments, for a highlighted preview. */
export function renderSegments(template: string, vars: Record<string, string>): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of template.matchAll(TAG_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: template.slice(last, start), kind: 'text' });
    const tag = m[1]!.toLowerCase();
    const value = vars[tag]?.trim();
    out.push(value ? { text: value, kind: 'value', tag } : { text: `{{${m[1]}}}`, kind: 'missing', tag });
    last = start + m[0].length;
  }
  if (last < template.length) out.push({ text: template.slice(last), kind: 'text' });
  return out;
}
