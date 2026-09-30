import { ApiErrorBodySchema, AttachmentSchema, type Attachment } from '@ri/shared';
import { ApiError, api } from './client';

/** Raw bytes, not JSON: the file goes up as-is and the server works out its type. */
export async function uploadAttachment(file: File): Promise<Attachment> {
  let res: Response;
  try {
    res = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Is the API running?');
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(json);
    throw new ApiError(res.status, parsed.success ? parsed.data.error.code : 'HTTP_ERROR', parsed.success ? parsed.data.error.message : `Upload failed (${res.status})`);
  }
  return AttachmentSchema.parse(json);
}

export const deleteAttachment = (id: string) => api(`/attachments/${id}`, { method: 'DELETE' });
export const attachmentUrl = (id: string) => `/api/attachments/${id}/download`;
