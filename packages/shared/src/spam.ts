import { flattenSpintax } from './spintax.js';

/**
 * Content check for cold email. A heuristic, not a real spam filter: it flags the patterns that
 * commonly push mail into spam (hype words, ALL CAPS, !!!, link-heavy bodies, bad subject lengths)
 * and offers a plainer replacement where one exists. Runs in the browser as you type.
 *
 * Merge tags are ignored and every spintax alternative is checked, so a flagged word can't hide in
 * one variant.
 */

export type SpamSeverity = 'high' | 'medium' | 'low';
export type SpamField = 'subject' | 'body';

export type SpamIssue = {
  id: string;
  field: SpamField;
  severity: SpamSeverity;
  /** Short label for the problem. */
  title: string;
  /** Why it matters / what to do. */
  detail: string;
  /** The exact text that triggered it (as written), when there is one. */
  match?: string;
  /** A plainer phrase to swap in; '' means "just delete it". */
  replacement?: string;
};

export type SpamGrade = 'great' | 'good' | 'risky' | 'poor';
export type SpamReport = { score: number; grade: SpamGrade; issues: SpamIssue[]; wordCount: number; linkCount: number };

type Phrase = { re: RegExp; severity: SpamSeverity; why: string; replacement?: string };

// Phrases are matched as whole words, case-insensitively. Replacements are deliberately plain.
const P = (words: string, severity: SpamSeverity, why: string, replacement?: string): Phrase => ({
  re: new RegExp(`(?<![\\w$])${words}(?![\\w])`, 'i'),
  severity,
  why,
  replacement,
});

const MONEY = 'Money and pricing language is a classic spam signal.';
const HYPE = 'Hype and over-promising reads as marketing blast, not a 1:1 email.';
const URGENT = 'Manufactured urgency is heavily penalised by spam filters.';
const SHADY = 'This phrase is strongly associated with scams.';
const CTA = 'Pushy calls to action trigger filters; a soft question works better.';

export const SPAM_PHRASES: Phrase[] = [
  P('100% free', 'high', MONEY, 'no-cost'),
  P('free', 'medium', MONEY, 'no-cost'),
  P('risk[- ]free', 'high', MONEY, 'low-commitment'),
  P('no cost', 'low', MONEY),
  P('no obligation', 'medium', MONEY),
  P('money[- ]back', 'high', MONEY),
  P('cash', 'medium', MONEY),
  P('\\$\\$+', 'high', MONEY, ''),
  P('make money', 'high', SHADY),
  P('earn (?:extra )?(?:money|cash|income)', 'high', SHADY),
  P('double your', 'high', HYPE, 'grow your'),
  P('lowest price', 'medium', MONEY),
  P('best price', 'medium', MONEY),
  P('cheap', 'medium', MONEY, 'affordable'),
  P('discount', 'low', MONEY),
  P('\\d{1,3}% off', 'medium', MONEY),
  P('save big', 'high', MONEY),
  P('bonus', 'low', MONEY),
  P('credit card', 'high', SHADY),
  P('buy now', 'high', CTA, 'take a look'),
  P('order now', 'high', CTA, 'take a look'),
  P('act now', 'high', URGENT, ''),
  P('call now', 'high', CTA, 'grab 15 minutes'),
  P('apply now', 'medium', CTA),
  P('sign up now', 'high', CTA),
  P('click here', 'high', `${CTA} Link the words that describe the destination instead.`),
  P('click below', 'high', CTA),
  P('limited[- ]time(?: only| offer)?', 'high', URGENT, ''),
  P('urgent', 'high', URGENT, 'timely'),
  P('act fast', 'high', URGENT, ''),
  P('hurry', 'high', URGENT, ''),
  P('expires? (?:today|tonight|soon)', 'high', URGENT),
  P('while supplies last', 'high', URGENT, ''),
  P('once in a lifetime', 'high', HYPE, ''),
  P('last chance', 'high', URGENT, ''),
  P("don['’]t miss (?:out|this)", 'medium', URGENT, ''),
  P('guaranteed', 'medium', HYPE, ''),
  P('guarantee', 'medium', `${HYPE} Describe a result you have actually seen instead.`),
  P('amazing', 'low', HYPE, 'useful'),
  P('incredible', 'low', HYPE, 'strong'),
  P('miracle', 'high', HYPE),
  P('revolutionary', 'medium', HYPE, 'new'),
  P('game[- ]changer', 'low', HYPE),
  P('exclusive deal', 'medium', HYPE),
  P('special promotion', 'medium', HYPE),
  P('winner', 'high', SHADY),
  P('congratulations', 'medium', SHADY),
  P('you(?: have|[’\']ve) been selected', 'high', SHADY),
  P('prize', 'high', SHADY),
  P('dear friend', 'medium', SHADY, 'Hi'),
  P('this is not spam', 'high', SHADY, ''),
  P('no catch', 'high', SHADY, ''),
  P('100% satisfied', 'medium', HYPE),
  P('instant(?:ly)?', 'low', HYPE),
  P('increase (?:sales|revenue|traffic)', 'low', HYPE),
  P('work from home', 'high', SHADY),
  P('viagra|casino|lottery|crypto giveaway', 'high', SHADY),
];

const SHORTENERS = /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly)\//i;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi;
// ALL-CAPS words of 4+ letters (short acronyms like CEO, SaaS-y bits, AI are fine).
const CAPS_RE = /\b[A-Z][A-Z]{3,}\b/g;

const WEIGHT: Record<SpamSeverity, number> = { high: 12, medium: 6, low: 2 };

/** Strip merge tags and expand spintax so we check what could actually be sent. */
function prepare(text: string): string {
  return flattenSpintax(text).replace(/\{\{[^}]*\}\}/g, ' ');
}

export function checkSpam(subjectTpl: string, bodyTpl: string): SpamReport {
  const issues: SpamIssue[] = [];
  const subject = prepare(subjectTpl);
  const body = prepare(bodyTpl);
  let n = 0;
  const add = (i: Omit<SpamIssue, 'id'>) => issues.push({ ...i, id: `${i.field}-${n++}` });

  for (const [field, text] of [
    ['subject', subject],
    ['body', body],
  ] as const) {
    for (const p of SPAM_PHRASES) {
      const m = text.match(p.re);
      if (!m) continue;
      // "free" inside "100% free" is already reported once.
      if (issues.some((x) => x.field === field && x.match && x.match.toLowerCase().includes(m[0].toLowerCase()))) continue;
      add({
        field,
        severity: field === 'subject' && p.severity !== 'high' ? (p.severity === 'low' ? 'medium' : 'high') : p.severity,
        title: `“${m[0]}”`,
        detail: p.why,
        match: m[0],
        replacement: p.replacement,
      });
    }

    const caps = [...new Set(text.match(CAPS_RE) ?? [])];
    if (caps.length) {
      add({
        field,
        severity: field === 'subject' || caps.length > 2 ? 'high' : 'medium',
        title: `ALL CAPS: ${caps.slice(0, 3).join(', ')}${caps.length > 3 ? '…' : ''}`,
        detail: 'Capitals read as shouting and are a common spam signal. Use normal case.',
        match: caps[0],
        replacement: caps[0]!.charAt(0) + caps[0]!.slice(1).toLowerCase(),
      });
    }

    const bangs = (text.match(/!/g) ?? []).length;
    const run = text.match(/!{2,}|\?{2,}|[!?]{3,}/);
    if (run) add({ field, severity: 'high', title: `Repeated punctuation “${run[0]}”`, detail: 'Stacked !!! or ??? is a strong spam signal.', match: run[0], replacement: run[0][0] });
    else if ((field === 'subject' && bangs > 0) || bangs > 2)
      add({ field, severity: field === 'subject' ? 'medium' : 'low', title: `${bangs} exclamation mark${bangs === 1 ? '' : 's'}`, detail: field === 'subject' ? 'Exclamation marks in a cold subject line look promotional.' : 'Keep exclamation marks to one or two.' });
  }

  // Subject shape
  const subjectWords = subject.trim().split(/\s+/).filter(Boolean);
  if (subjectTpl.trim() && subject.trim().length > 70)
    add({ field: 'subject', severity: 'medium', title: `Long subject (${subject.trim().length} characters)`, detail: 'Cold subjects work best under ~60 characters; longer ones get cut off.' });
  if (subjectTpl.trim() && subjectWords.length > 0 && subjectWords.length < 2 && !/\{\{/.test(subjectTpl))
    add({ field: 'subject', severity: 'low', title: 'Very short subject', detail: 'A one-word subject gives the reader no reason to open.' });
  if (/^\s*(re|fwd?)\s*:/i.test(subject))
    add({ field: 'subject', severity: 'high', title: 'Fake “Re:” / “Fwd:”', detail: 'Pretending to be a reply is deceptive and gets flagged — and it damages trust.', match: subject.match(/^\s*(re|fwd?)\s*:\s*/i)![0], replacement: '' });

  // Body shape
  const words = body.trim().split(/\s+/).filter(Boolean);
  const links = body.match(URL_RE) ?? [];
  if (bodyTpl.trim() && words.length < 25)
    add({ field: 'body', severity: 'low', title: `Short body (${words.length} words)`, detail: 'A few sentences of genuine context tends to land better than a one-liner.' });
  if (words.length > 220)
    add({ field: 'body', severity: 'medium', title: `Long body (${words.length} words)`, detail: 'Cold emails over ~200 words get fewer replies and look like newsletters.' });
  if (links.length > 2) add({ field: 'body', severity: links.length > 4 ? 'high' : 'medium', title: `${links.length} links`, detail: 'Several links in a first email looks like marketing. One link, or none, is safest.' });
  const short = body.match(SHORTENERS);
  if (short) add({ field: 'body', severity: 'high', title: `Link shortener (${short[0].replace(/\/$/, '')})`, detail: 'Shortened links hide the destination and are widely blocked. Use the full URL.' });

  // Score: severity-weighted, with diminishing returns so one bad word doesn't read as 0.
  const penalty = issues.reduce((s, i) => s + WEIGHT[i.severity], 0);
  const score = Math.max(0, Math.round(100 * Math.exp(-penalty / 60)));
  const grade: SpamGrade = score >= 85 ? 'great' : score >= 70 ? 'good' : score >= 50 ? 'risky' : 'poor';
  const order: Record<SpamSeverity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { score, grade, issues, wordCount: words.length, linkCount: links.length };
}

/**
 * Applies a suggested replacement to the template it came from (first whole-word occurrence,
 * case-insensitive), keeping the original's leading capital. Leaves merge tags and spintax syntax alone.
 */
export function applySpamFix(tpl: string, match: string, replacement: string): string {
  const esc = match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w$])${esc}(?![\\w])\\s?`, 'i');
  return tpl
    .replace(re, (found) => {
      const trailing = found.endsWith(' ') ? ' ' : '';
      if (!replacement) return '';
      const cap = /^[A-Z]/.test(found) && !/^[A-Z]{2,}/.test(found);
      return (cap ? replacement[0]!.toUpperCase() + replacement.slice(1) : replacement) + trailing;
    })
    .replace(/ {2,}/g, ' ')
    .split('\n')
    .map(tidyLine)
    .join('\n');
}

/** Clean up what a removal leaves behind: " ,", ". !", a dangling " - " or a lone "!" at the edges. */
function tidyLine(line: string): string {
  return line
    .replace(/[ \t]+([,.!?;:])/g, '$1') // no space before punctuation
    .replace(/([.!?])[.!?]+/g, '$1') // ". !" → "."
    .replace(/\s*[-–—]\s*([!?.]*)\s*$/, '$1') // "trial - !" → "trial!"
    .replace(/^\s*[-–—,;:]\s*/, '') // leading separator
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase()); // sentence case after a removal
}
