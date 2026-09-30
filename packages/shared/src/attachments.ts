import { z } from 'zod';

/**
 * Attachments: what may be sent, and how much. The server decides the type from the extension and the file's
 * leading bytes; the browser's claim about the type is never used.
 */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024;

/** Extension → content type. Nothing executable, scriptable (svg, html) or archive-like is here. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).map((e) => `.${e}`).join(',');

export const AttachmentSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  size: z.number(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The part after the last dot, lowercased ("" when there is none). */
export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** A safe display/download name: no path, no control characters, bounded length, extension kept. */
export function cleanFileName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const flat = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (flat.length <= 120) return flat;
  const ext = extensionOf(flat);
  return `${flat.slice(0, 115 - ext.length)}.${ext}`;
}
