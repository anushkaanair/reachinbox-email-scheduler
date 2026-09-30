/**
 * Rich-text email bodies. The editor produces HTML from a small, fixed set of tags; the server re-sanitises
 * it with the same allowlist (never trusting the browser), and every other part of the system (previews, the
 * spam check, search, the plain-text alternative) works from the text version made here.
 */

export const BODY_FORMATS = ['TEXT', 'HTML'] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

/** What the toolbar can produce. Anything else is dropped when the server sanitises. */
export const ALLOWED_TAGS = ['p', 'div', 'br', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'ul', 'ol', 'li', 'blockquote', 'a'] as const;
export const FONT_SIZES = ['x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'] as const;
export const TEXT_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
/** Indent is stored as a left margin, in steps of 24px, up to five steps. */
export const INDENT_STEP_PX = 24;
export const MAX_INDENT_STEPS = 5;

/** Links may only point somewhere a recipient can safely open. */
export const isSafeHref = (href: string) => /^(https?:\/\/|mailto:)/i.test(href.trim());

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Plain-text version of an HTML body: line breaks where blocks end, bullets for list items. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
    .replace(/<\s*\/\s*(p|div|li|blockquote|h[1-6]|ul|ol)\s*>/gi, '\n')
    .replace(/<\s*(p|div|blockquote)\b[^>]*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text as HTML, for opening an older plain-text message in the editor. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** True when the HTML has nothing a recipient would see (e.g. `<div><br></div>`). */
export const isHtmlEmpty = (html: string) => htmlToText(html).length === 0;
