import sanitizeHtml from 'sanitize-html';
import { ALLOWED_TAGS, FONT_SIZES, INDENT_STEP_PX, isSafeHref, MAX_INDENT_STEPS, TEXT_ALIGNS } from '@ri/shared';

/**
 * The server's own pass over every rich-text body, whatever the browser sent. Allowlist only: the tags
 * the toolbar produces, three style properties with fixed value sets, and links to http(s)/mailto.
 * Scripts, event handlers, images, iframes, forms and `javascript:` links cannot survive this.
 */
// 0 to 120px (INDENT_STEP_PX × MAX_INDENT_STEPS); kept as a literal so it is easy to read against the constants.
const MARGIN = /^(0|([1-9]|[1-9]\d|1[01]\d|120)px)$/;
if (INDENT_STEP_PX * MAX_INDENT_STEPS !== 120) throw new Error('update MARGIN in sanitizeHtml.ts to match the indent limits');

export function sanitizeBody(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...ALLOWED_TAGS],
    allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['style'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        'text-align': [new RegExp(`^(${TEXT_ALIGNS.join('|')})$`)],
        'font-size': [new RegExp(`^(${FONT_SIZES.join('|')})$`)],
        'margin-left': [MARGIN],
      },
    },
    transformTags: {
      a: (tag, attribs) => {
        const href = attribs.href ?? '';
        const safe: Record<string, string> = isSafeHref(href) ? { href, target: '_blank', rel: 'noopener noreferrer nofollow' } : {};
        return { tagName: 'a', attribs: safe };
      },
    },
    // A script's or style's *text* would survive stripping the tag, so drop it entirely.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
  });
}
