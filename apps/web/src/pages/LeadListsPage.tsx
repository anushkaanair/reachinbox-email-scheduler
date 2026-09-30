import { AlertTriangle, ListChecks, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { RecipientsField } from '@/components/compose/RecipientsField';
import { StatusBar } from '@/components/leads/StatusBar';
import { Button, buttonClass } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCreateLeadList, useDeleteLeadList, useLeadLists } from '@/hooks/useLeadLists';
import { relative } from '@/lib/format';
import { EMPTY_RECIPIENTS, type Recipients } from '@/lib/recipients';
import type { LeadListSummary } from '@ri/shared';

const nf = new Intl.NumberFormat();

function NewListModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateLeadList();
  const [name, setName] = useState('');
  const [recipients, setRecipients] = useState<Recipients>(EMPTY_RECIPIENTS);
  const [error, setError] = useState<string>();
  const close = () => {
    setName('');
    setRecipients(EMPTY_RECIPIENTS);
    setError(undefined);
    onClose();
  };
  const save = () => {
    if (!name.trim()) return setError('Give the list a name');
    if (recipients.leads.length === 0) return setError('Add at least one address');
    create.mutate({ name: name.trim(), leads: recipients.leads }, { onSuccess: (l) => { toast.success(`Saved “${l.name}” with ${nf.format(l.total)} addresses`); close(); }, onError: (e) => setError(e.message) });
  };
  return (
    <Modal open={open} onClose={close} title="New lead list" className="max-w-2xl" footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={save} loading={create.isPending}>Save list</Button></>}>
      <div className="flex flex-col gap-5">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Conference attendees" maxLength={80} />
        <div>
          <p className="mb-1 text-sm font-medium">Addresses</p>
          <RecipientsField value={recipients} onChange={setRecipients} />
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Modal>
  );
}

function ListCard({ l, onDelete }: { l: LeadListSummary; onDelete: () => void }) {
  return (
    <article className="rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold"><Link to={`/lead-lists/${l.id}`} className="hover:underline">{l.name}</Link></h2>
          <p className="text-xs text-muted">{nf.format(l.total)} address{l.total === 1 ? '' : 'es'} · updated {relative(l.updatedAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/lead-lists/${l.id}`} className={buttonClass('secondary', 'sm')}>Open</Link>
          <Link to={`/compose?list=${l.id}`} className={buttonClass('secondary', 'sm', 'border-brand-600 text-brand-600')}>Use in a campaign</Link>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete ${l.name}`}><Trash2 className="size-4" /></Button>
        </div>
      </div>
      <div className="mt-4"><StatusBar counts={l.counts} total={l.total} /></div>
    </article>
  );
}

/** Saved recipient lists: create from typed or uploaded addresses, check them, then send to them. */
export function LeadListsPage() {
  const { data, isPending, error, refetch } = useLeadLists();
  const del = useDeleteLeadList();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<LeadListSummary | null>(null);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lead lists</h1>
          <p className="text-sm text-muted">Save recipients once, check which domains can actually receive mail, and send to the list any time.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="size-4" /> New list</Button>
      </div>

      {error ? (
        <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load your lists" description={error.message} action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>} />
      ) : isPending ? (
        <div className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState icon={ListChecks} title="No lists yet" description="Paste addresses or upload a CSV, save them as a list, and check them before you send." action={<Button onClick={() => setCreating(true)}><Plus className="size-4" /> New list</Button>} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {data.map((l) => <ListCard key={l.id} l={l} onDelete={() => setRemoving(l)} />)}
          <p className="text-xs text-muted">“Valid domain” means the domain can receive email and the address isn’t an obvious problem. It does not prove the mailbox exists: we never contact the mailbox, because that is unreliable and can hurt your sender reputation.</p>
        </div>
      )}

      <NewListModal open={creating} onClose={() => setCreating(false)} />
      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Delete “${removing?.name ?? ''}”?`}
        footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={del.isPending} onClick={() => removing && del.mutate(removing.id, { onSuccess: () => { toast('List deleted'); setRemoving(null); } })}>Delete list</Button></>}
      >
        <p className="text-sm text-soft">The list and its {nf.format(removing?.total ?? 0)} addresses are removed. Campaigns already scheduled from it are not affected.</p>
      </Modal>
    </div>
  );
}
