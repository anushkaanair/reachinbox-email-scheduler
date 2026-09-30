import { AlertTriangle, Upload, X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { ACCEPTED_EXTENSIONS } from '@/lib/csv';
import { EMPTY_RECIPIENTS, addFile, addTyped, removeLead, type Recipients } from '@/lib/recipients';
import { cn } from '@/lib/cn';

const SHOWN = 3;
const nf = new Intl.NumberFormat();

/**
 * "To" from the Figma frame: address chips (first three, then "+N"), a box to type or paste more,
 * and an "Upload List" action. Typed and uploaded addresses merge into one deduplicated list, and the
 * summary underneath says exactly how many addresses were detected.
 */
export function RecipientsField({ value, onChange, error }: { value: Recipients; onChange: (v: Recipients) => void; error?: string }) {
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [over, setOver] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const id = useId();

  const commit = (text: string) => {
    if (!text.trim()) return;
    const { next, rejected } = addTyped(value, text);
    onChange(next);
    setNote(rejected.length ? `${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '…' : ''} ${rejected.length === 1 ? 'isn’t' : 'aren’t'} valid addresses and ${rejected.length === 1 ? 'was' : 'were'} skipped.` : null);
    setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      }
    } else if (e.key === 'Backspace' && !draft && value.leads.length) {
      onChange(removeLead(value, value.leads.at(-1)!.email));
    }
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    const r = await addFile(value, f);
    if ('error' in r) setNote(r.error);
    else {
      setNote(null);
      onChange(r.next);
    }
    if (file.current) file.current.value = '';
  };

  const shown = expanded ? value.leads : value.leads.slice(0, SHOWN);
  const hidden = value.leads.length - shown.length;
  const message = note ?? error;
  const { invalid, duplicates, truncated } = value;

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files[0]); }}
        className={cn('flex items-start gap-3 border-b py-2 transition-colors', over ? 'border-brand-600 bg-brand-50/60' : error ? 'border-danger-solid' : 'border-line')}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {shown.map((l) => (
            <span key={l.email} className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-600/60 bg-brand-50 py-0.5 pr-1 pl-3 text-sm text-ink">
              <span className="truncate">{l.email}</span>
              <button type="button" onClick={() => onChange(removeLead(value, l.email))} aria-label={`Remove ${l.email}`} className="rounded-full p-0.5 text-muted hover:text-ink">
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="rounded-full border border-brand-600/60 bg-brand-50 px-3 py-0.5 text-sm text-ink hover:bg-brand-100" aria-label={`Show ${hidden} more recipients`}>
              +{nf.format(hidden)}
            </button>
          )}
          {expanded && value.leads.length > SHOWN && (
            <button type="button" onClick={() => setExpanded(false)} className="px-1 text-xs text-muted hover:text-ink">Show fewer</button>
          )}
          <input
            id={id}
            aria-label="Recipients"
            aria-invalid={Boolean(error)}
            type="text"
            inputMode="email"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => commit(draft)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (/[\s,;]/.test(text.trim())) {
                e.preventDefault();
                commit(text);
              }
            }}
            placeholder={value.leads.length ? '' : 'recipient@example.com'}
            className="min-w-44 flex-1 bg-transparent py-1 text-[15px] placeholder:text-muted focus:outline-none"
          />
        </div>
        <button type="button" onClick={() => file.current?.click()} className="flex shrink-0 items-center gap-1.5 py-1 text-sm font-medium text-brand-600 hover:underline">
          <Upload className="size-4" aria-hidden /> Upload List
        </button>
        <input ref={file} type="file" accept={ACCEPTED_EXTENSIONS.join(',')} className="sr-only" tabIndex={-1} aria-label="Upload a CSV or TXT list of recipients" onChange={(e) => void upload(e.target.files?.[0])} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-live="polite">
        {value.leads.length > 0 ? (
          <span className="font-semibold text-brand-700">{nf.format(value.leads.length)} email{value.leads.length === 1 ? '' : 's'} detected</span>
        ) : (
          <span className="text-muted">Type addresses, or upload a CSV or TXT list (an “email” column; other columns become {'{{merge_tags}}'}).</span>
        )}
        {value.fileName && value.leads.length > 0 && <span className="text-muted">from {value.fileName}</span>}
        {invalid.length > 0 && <span className="text-danger">{nf.format(invalid.length)} invalid skipped</span>}
        {duplicates > 0 && <span className="text-warn">{nf.format(duplicates)} duplicate{duplicates === 1 ? '' : 's'} removed</span>}
        {truncated && <span className="flex items-center gap-1 text-warn"><AlertTriangle className="size-3" aria-hidden /> Limited to the first 10,000</span>}
        {value.leads.length > 0 && (
          <button type="button" onClick={() => { onChange(EMPTY_RECIPIENTS); setNote(null); }} className="text-muted hover:text-ink">Clear all</button>
        )}
      </div>
      {message && <p role="alert" className="mt-1 text-xs text-danger">{message}</p>}
    </div>
  );
}
