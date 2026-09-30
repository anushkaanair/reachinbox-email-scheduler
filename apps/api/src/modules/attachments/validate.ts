import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, cleanFileName, extensionOf } from '@ri/shared';

export type UploadCheck = { ok: true; fileName: string; contentType: string } | { ok: false; message: string };

const startsWith = (b: Buffer, bytes: number[]) => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
const ascii = (b: Buffer, s: string) => b.length >= s.length && b.subarray(0, s.length).toString('latin1') === s;

/** The file must really be what its extension says, using its first bytes. Text files must not contain binary data. */
const SNIFF: Record<string, (b: Buffer) => boolean> = {
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => ascii(b, 'GIF87a') || ascii(b, 'GIF89a'),
  pdf: (b) => ascii(b, '%PDF-'),
  docx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  xlsx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  pptx: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]),
  txt: (b) => !b.subarray(0, 8192).includes(0),
  csv: (b) => !b.subarray(0, 8192).includes(0),
};

/** Decide whether an upload is acceptable, and what to call it. The client's claimed type is never consulted. */
export function checkUpload(rawName: string, data: Buffer): UploadCheck {
  const fileName = cleanFileName(rawName);
  if (!fileName) return { ok: false, message: 'The file needs a name.' };
  const ext = extensionOf(fileName);
  const contentType = ATTACHMENT_TYPES[ext];
  if (!contentType) return { ok: false, message: `.${ext || '(none)'} files can’t be attached. Allowed: ${Object.keys(ATTACHMENT_TYPES).join(', ')}.` };
  if (data.length === 0) return { ok: false, message: 'That file is empty.' };
  if (data.length > MAX_ATTACHMENT_BYTES) return { ok: false, message: 'That file is larger than 5 MB.' };
  if (!SNIFF[ext]!(data)) return { ok: false, message: `That doesn’t look like a real .${ext} file.` };
  return { ok: true, fileName, contentType };
}
