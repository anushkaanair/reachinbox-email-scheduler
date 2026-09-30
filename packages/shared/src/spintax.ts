import { seededRandom } from './random.js';

/**
 * Spintax: `{Hi|Hello|Hey} {{name}}` → one alternative per recipient, so every email isn't
 * byte-identical. Groups may nest (`{a|{b|c}}`) and options may be empty (`{|really }`).
 * `{{merge_tags}}` are left untouched — spintax is resolved first, then merge tags, so a lead's own
 * data (a company called "{A|B}") is never interpreted as spintax.
 */

type Node = string | { options: Node[][] };

export type SpintaxResult = { ok: true; ast: Node[] } | { ok: false; error: string; index: number };

const MAX_DEPTH = 8;

export function parseSpintax(tpl: string): SpintaxResult {
  let i = 0;

  function parseSeq(depth: number, inGroup: boolean): Node[] | { error: string; index: number } {
    const out: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (i < tpl.length) {
      const ch = tpl[i]!;
      if (ch === '{' && tpl[i + 1] === '{') {
        // A merge tag: copy through to its closing }} verbatim.
        const end = tpl.indexOf('}}', i + 2);
        if (end < 0) return { error: 'A “{{” merge tag is never closed with “}}”.', index: i };
        text += tpl.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (ch === '{') {
        if (depth >= MAX_DEPTH) return { error: 'Spintax is nested too deeply.', index: i };
        const start = i;
        i++;
        const options: Node[][] = [];
        for (;;) {
          const opt = parseSeq(depth + 1, true);
          if (!Array.isArray(opt)) return opt;
          options.push(opt);
          if (i >= tpl.length) return { error: 'A “{” is never closed with “}”.', index: start };
          if (tpl[i] === '|') {
            i++;
            continue;
          }
          i++; // the closing }
          break;
        }
        if (options.length < 2) {
          const inner = tpl.slice(start + 1, i - 1);
          return {
            error: `“{${inner}}” has only one option. Use {{${inner || 'name'}}} for a merge tag, or {a|b} for alternatives.`,
            index: start,
          };
        }
        flush();
        out.push({ options });
        continue;
      }
      if (inGroup && (ch === '|' || ch === '}')) break;
      if (ch === '}') {
        if (tpl[i + 1] === '}') return { error: 'A “}}” has no matching “{{”.', index: i };
        return { error: 'A “}” has no matching “{”.', index: i };
      }
      text += ch;
      i++;
    }
    flush();
    return out;
  }

  const ast = parseSeq(0, false);
  if (!Array.isArray(ast)) return { ok: false, ...ast };
  return { ok: true, ast };
}

export const hasSpintax = (tpl: string) => {
  const r = parseSpintax(tpl);
  return r.ok && r.ast.some((n) => typeof n !== 'string');
};

/** Human-readable problem with a template's spintax, or null when it's valid (or has none). */
export function spintaxError(tpl: string): string | null {
  const r = parseSpintax(tpl);
  return r.ok ? null : r.error;
}

function renderNodes(nodes: Node[], rnd: () => number): string {
  let s = '';
  for (const n of nodes) {
    if (typeof n === 'string') s += n;
    else s += renderNodes(n.options[Math.floor(rnd() * n.options.length)]!, rnd);
  }
  return s;
}

/**
 * Picks one variant, deterministically from `seed` (use the recipient's address). Invalid spintax
 * is returned unchanged — callers validate first and refuse to schedule it.
 */
export function spin(tpl: string, seed: string): string {
  const r = parseSpintax(tpl);
  if (!r.ok) return tpl;
  return renderNodes(r.ast, seededRandom(`spin:${seed}`));
}

const CAP = 1_000_000;
function countNodes(nodes: Node[]): number {
  let total = 1;
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    let sum = 0;
    for (const o of n.options) sum = Math.min(CAP, sum + countNodes(o));
    total = Math.min(CAP, total * sum);
  }
  return total;
}

/** How many distinct versions a template can produce (capped at 1,000,000). */
export function spintaxVariants(tpl: string): number {
  const r = parseSpintax(tpl);
  return r.ok ? countNodes(r.ast) : 0;
}

/** Every option's text laid out side by side — used to spam-check all alternatives at once. */
export function flattenSpintax(tpl: string): string {
  const r = parseSpintax(tpl);
  if (!r.ok) return tpl;
  const flat = (nodes: Node[]): string => nodes.map((n) => (typeof n === 'string' ? n : n.options.map(flat).join(' '))).join('');
  return flat(r.ast);
}

/** One representative variant (the first option of every group): what a single recipient's email looks like, for counting words. */
export function firstSpintax(tpl: string): string {
  const r = parseSpintax(tpl);
  if (!r.ok) return tpl;
  const one = (nodes: Node[]): string => nodes.map((n) => (typeof n === 'string' ? n : one(n.options[0] ?? []))).join('');
  return one(r.ast);
}
