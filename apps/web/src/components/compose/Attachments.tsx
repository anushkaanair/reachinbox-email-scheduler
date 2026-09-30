import { FileText, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ATTACHMENT_ACCEPT, ATTACHMENT_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_BYTES, MAX_ATTACHMENT_BYTES, extensionOf, formatBytes, type Attachment } from '@ri/shared';
import { deleteAttachment, uploadAttachment } from '@/api/attachments';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';

export type Staged = Attachment & { /** Local preview for images; revoked when removed. */ previewUrl?: string };

/** Files chosen for this email: uploaded at once, removable until it is scheduled. */
export function useAttachments() {
  const [items, setItems] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Staged[]>([]);
  live.current = items;

  useEffect(() => () => live.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)), []);

  const add = useCallback(async (files: File[]) => {
    setError(null);
    let count = live.current.length;
    let total = live.current.reduce((n, a) => n + a.size, 0);
    for (const file of files) {
      // The server checks all of this again; these checks just save an upload that would be refused.
      if (!ATTACHMENT_TYPES[extensionOf(file.name)]) return void setError(`.${extensionOf(file.name) || '(none)'} files can’t be attached. Allowed: ${Object.keys(ATTACHMENT_TYPES).join(', ')}.`);
      if (file.size > MAX_ATTACHMENT_BYTES) return void setError(`${file.name} is larger than 5 MB.`);
      if (count >= MAX_ATTACHMENTS) return void setError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      if (total + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) return void setError('Attachments can total up to 10 MB.');
      count++;
      total += file.size;
      setBusy((b) => b + 1);
      try {
        const a = await uploadAttachment(file);
        const previewUrl = a.contentType.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setItems((cur) => [...cur, { ...a, previewUrl }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed');
        count--;
        total -= file.size;
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    const a = live.current.find((x) => x.id === id);
    setItems((cur) => cur.filter((x) => x.id !== id));
    if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
    await deleteAttachment(id).catch(() => undefined); // already gone is fine
  }, []);

  return { items, busy: busy > 0, error, add, remove, ids: items.map((i) => i.id) };
}

/** The paperclip from the Figma frame, with the number of files attached. */
export function AttachButton({ count, busy, onPick }: { count: number; busy: boolean; onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label={count ? `Attach files (${count} attached)` : 'Attach files'}
        className={cn('relative grid size-10 place-items-center rounded-full text-brand-600 transition-colors hover:bg-neutral-soft', count > 0 && 'bg-brand-50 text-brand-700')}
      >
        {busy ? <Spinner className="size-5" label="Uploading" /> : <Paperclip className="size-[22px]" aria-hidden />}
        {count > 0 && <span className="absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full bg-brand-600 text-[10px] font-semibold text-on-brand" aria-hidden>{count}</span>}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        tabIndex={-1}
        className="sr-only"
        aria-label="Choose files to attach"
        onChange={(e) => {
          onPick(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Thumbnails (images) and file cards under the editor, as in the Figma frame. */
export function AttachmentList({ items, onRemove, error }: { items: Staged[]; onRemove: (id: string) => void; error: string | null }) {
  if (items.length === 0 && !error) return null;
  return (
    <div>
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-3" aria-label="Attachments">
          {items.map((a) => (
            <li key={a.id} className="group relative w-56 overflow-hidden rounded-xl bg-neutral-soft">
              {a.previewUrl ? <img src={a.previewUrl} alt="" className="h-28 w-full object-cover" /> : <div className="grid h-28 place-items-center text-muted"><FileText className="size-9" aria-hidden /></div>}
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium" title={a.fileName}>{a.fileName}</p>
                <p className="text-xs text-muted">{formatBytes(a.size)}</p>
              </div>
              <button type="button" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.fileName}`} className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-full bg-surface/90 text-ink shadow-sm hover:bg-surface">
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
