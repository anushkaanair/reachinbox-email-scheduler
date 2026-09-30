import { FONT_SIZES, INDENT_STEP_PX, isSafeHref, MAX_INDENT_STEPS, TEXT_ALIGNS, ALLOWED_TAGS } from '@ri/shared';

/**
 * Browser-side twin of the server's allowlist (apps/api/src/lib/sanitizeHtml.ts): the editor's output is
 * cleaned before it is stored in form state or rendered in a preview. The server sanitises again; this
 * pass keeps the UI honest and makes rendering HTML safe on its own. Parsing uses an inert document, so
 * nothing in the input can run while it is being cleaned.
 */
const KEEP = new Set<string>(ALLOWED_TAGS);
// Dropped together with everything inside them (their text would otherwise leak into the message).
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'textarea', 'option', 'noscript', 'template', 'svg', 'math']);
const MAX_MARGIN = INDENT_STEP_PX * MAX_INDENT_STEPS;

function cleanStyle(raw: string): string {
  const out: string[] = [];
  for (const decl of raw.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim().toLowerCase();
    if (prop === 'text-align' && (TEXT_ALIGNS as readonly string[]).includes(val)) out.push(`text-align:${val}`);
    else if (prop === 'font-size' && (FONT_SIZES as readonly string[]).includes(val)) out.push(`font-size:${val}`);
    else if (prop === 'margin-left') {
      const m = /^(\d{1,3})px$/.exec(val) ?? (val === '0' ? ['0', '0'] : null);
      if (m && Number(m[1]) <= MAX_MARGIN) out.push(`margin-left:${val}`);
    }
  }
  return out.join(';');
}

function clean(node: Node, doc: Document, into: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      into.appendChild(doc.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) {
      clean(el, doc, into); // unknown tag: keep its text, lose the tag
      continue;
    }
    const copy = doc.createElement(tag);
    const style = cleanStyle(el.getAttribute('style') ?? '');
    if (style) copy.setAttribute('style', style);
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (isSafeHref(href)) {
        copy.setAttribute('href', href);
        copy.setAttribute('target', '_blank');
        copy.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    clean(el, doc, copy);
    into.appendChild(copy);
  }
}

export function sanitizeClient(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}`, 'text/html');
  const out = parsed.createElement('div');
  clean(parsed.body, parsed, out);
  return out.innerHTML;
}
