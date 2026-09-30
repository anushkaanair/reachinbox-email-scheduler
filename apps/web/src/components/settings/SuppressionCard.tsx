import { Ban, FileUp, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAddSuppressions, useRemoveSuppression, useSuppressions } from '@/hooks/useCompose';
import { useDebounced } from '@/hooks/useIntegrations';
import { formatWhen } from '@/lib/format';

const nf = new Intl.NumberFormat();

/** Any address-looking tokens from pasted text or an uploaded .csv/.txt (the server validates them). */
const tokens = (text: string) => text.split(/[\s,;]+/).map((t) => t.replace(/^[<"'(]+|[>"'),.]+$/g, '')).filter((t) => t.includes('@'));

/** Settings card: the user's do-not-contact list. Leads on it are never emailed. */
export function SuppressionCard() {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useSuppressions(dq.trim());
  const add = useAddSuppressions();
  const remove = useRemoveSuppression();
  const file = useRef<HTMLInputElement>(null);

  const submit = (emails: string[]) => {
    if (emails.length === 0) return toast.error('No email addresses found');
    add.mutate(emails, {
      onSuccess: (r) => {
        setText('');
        toast.success(`Added ${nf.format(r.added)} to the list`, {
          description: [r.alreadyListed ? `${r.alreadyListed} already on it` : '', r.invalid.length ? `${r.invalid.length} invalid skipped` : ''].filter(Boolean).join(' · ') || undefined,
        });
      },
    });
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast.error('File is larger than 5 MB');
    submit(tokens(await f.text()));
    if (file.current) file.current.value = '';
  };

  const total = list.data?.total ?? 0;
  const items = list.data?.items ?? [];

  return (
    <section id="do-not-contact" className="scroll-mt-6 rounded-xl border border-line bg-surface" aria-labelledby="dnc-title">
      <header className="flex items-start gap-4 border-b border-line p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-danger-soft text-danger">
          <Ban className="size-6" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="dnc-title" className="text-base font-semibold">Do-not-contact list</h2>
            {list.data && <Badge tone={total ? 'warning' : 'neutral'}>{nf.format(total)} {q.trim() ? 'match' : 'blocked'}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted">Anyone here is skipped in every campaign — opt-outs, bounces, competitors, your own team.</p>
        </div>
      </header>

      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <Textarea
            label="Add addresses"
            rows={3}
            placeholder={'jane@example.com, bob@example.com\n(paste any list — commas, spaces or new lines)'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => submit(tokens(text))} loading={add.isPending} disabled={!text.trim()}>Add to list</Button>
            <Button variant="secondary" onClick={() => file.current?.click()} disabled={add.isPending}>
              <FileUp className="size-4" /> Upload CSV / TXT
            </Button>
            <input ref={file} type="file" accept=".csv,.txt" className="sr-only" aria-label="Upload a CSV or TXT of addresses" onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </div>

        {(total > 0 || q) && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              aria-label="Search the do-not-contact list"
              placeholder="Search the list…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-9 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
            />
          </div>
        )}

        {list.isPending ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">{q ? 'No matches.' : 'Nobody is blocked yet.'}</p>
        ) : (
          <>
            <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line" aria-label="Blocked addresses">
              {items.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{s.email}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="hidden text-xs text-muted sm:inline">{formatWhen(s.createdAt)}</span>
                    <button
                      type="button"
                      onClick={() => remove.mutate(s.id, { onSuccess: () => toast(`Removed ${s.email}`) })}
                      aria-label={`Remove ${s.email}`}
                      className="rounded p-1 text-muted hover:bg-neutral-soft hover:text-danger"
                    >
                      <X className="size-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {total > items.length && <p className="text-xs text-muted">Showing the {items.length} most recent of {nf.format(total)} — search to find others.</p>}
          </>
        )}
      </div>
    </section>
  );
}
