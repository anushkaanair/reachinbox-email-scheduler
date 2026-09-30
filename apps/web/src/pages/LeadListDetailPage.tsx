import { AlertTriangle, ArrowLeft, Download, Lightbulb, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LEAD_REASON_LABEL, LEAD_STATUS_LABEL, type LeadRow, type LeadStatus, type StatusTone } from '@ri/shared';
import { leadListExportUrl } from '@/api/leadLists';
import { StatusBar } from '@/components/leads/StatusBar';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonClass } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useLeadList, useLeadPage, useRemoveLeads, useVerifyLeadList } from '@/hooks/useLeadLists';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat();
const TONE: Record<LeadStatus, StatusTone> = { VALID: 'success', RISKY: 'warning', UNDELIVERABLE: 'danger', UNKNOWN: 'neutral' };

const FILTERS = [
  { key: undefined, label: 'All' },
  { key: 'VALID', label: 'Valid domain' },
  { key: 'RISKY', label: 'Risky' },
  { key: 'UNDELIVERABLE', label: 'Undeliverable' },
  { key: 'UNKNOWN', label: 'Couldn’t check' },
  { key: 'UNCHECKED', label: 'Not checked' },
] as const;

function Verdict({ l }: { l: LeadRow }) {
  if (!l.status) return <span className="text-xs text-muted">Not checked</span>;
  return (
    <div>
      <Badge tone={TONE[l.status]}>{LEAD_STATUS_LABEL[l.status]}</Badge>
      {l.reason && <p className="mt-0.5 text-xs text-muted">{LEAD_REASON_LABEL[l.reason]}</p>}
      {l.suggestion && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-brand-700"><Lightbulb className="size-3" aria-hidden /> Did you mean <span className="font-medium">{l.suggestion}</span>?</p>
      )}
    </div>
  );
}

/** One list: its verdicts, a Verify button that carries on until everything is checked, cleanup, export, and "send to this list". */
export function LeadListDetailPage() {
  const { id = '' } = useParams();
  const list = useLeadList(id);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const page = useLeadPage(id, status);
  const verify = useVerifyLeadList();
  const remove = useRemoveLeads();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const l = list.data;
  const runVerify = async () => {
    if (!l) return;
    const total = l.counts.unchecked;
    let done = 0;
    setProgress({ done, total });
    try {
      // Each call checks as many as it can in its time budget; repeat until nothing is left or a call makes no progress.
      for (let i = 0; i < 60; i++) {
        const r = await verify.mutateAsync(id);
        done += r.checked;
        setProgress({ done, total });
        if (r.remaining === 0) break;
        if (r.checked === 0) {
          toast.error('Some domains didn’t answer in time. Try again in a moment.');
          break;
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setProgress(null);
    }
  };

  if (list.error) {
    return <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t open this list" description={list.error.message} action={<Link to="/lead-lists" className={buttonClass('secondary')}>Back to lists</Link>} />;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/lead-lists" className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden /> Lead lists</Link>
      {!l ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight">{l.name}</h1>
              <p className="text-sm text-muted">{nf.format(l.total)} address{l.total === 1 ? '' : 'es'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void runVerify()} loading={progress !== null} disabled={l.counts.unchecked === 0 && progress === null}>
                <ShieldCheck className="size-4" /> {l.counts.unchecked === 0 ? 'All checked' : `Check ${nf.format(l.counts.unchecked)} address${l.counts.unchecked === 1 ? '' : 'es'}`}
              </Button>
              <a href={leadListExportUrl(id, status)} download className={buttonClass('secondary')}><Download className="size-4" /> Export CSV</a>
              <Link to={`/compose?list=${id}`} className={buttonClass('secondary', 'md', 'border-brand-600 text-brand-600')}>Use in a campaign</Link>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-line bg-surface p-5">
            <StatusBar counts={l.counts} total={l.total} />
            {progress && <p role="status" className="mt-3 text-sm text-muted">Checked {nf.format(progress.done)} of {nf.format(progress.total)}…</p>}
            {l.counts.undeliverable > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                <span className="flex-1">{nf.format(l.counts.undeliverable)} address{l.counts.undeliverable === 1 ? '' : 'es'} can’t receive mail. Sending to them makes bounces, which hurt every sender’s reputation.</span>
                <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>Remove them</Button>
              </div>
            )}
            <p className="mt-3 text-xs text-muted">“Valid domain” means the domain can receive email and the address isn’t an obvious problem. It doesn’t prove the mailbox exists: we never contact the mailbox.</p>
          </div>

          <div className="mt-5 flex flex-wrap gap-1.5" role="group" aria-label="Filter by result">
            {FILTERS.map((f) => (
              <button key={f.label} type="button" aria-pressed={status === f.key} onClick={() => setStatus(f.key)} className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', status === f.key ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-muted hover:text-ink')}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface">
            {page.error ? (
              <p role="alert" className="p-6 text-sm text-danger">{page.error.message}</p>
            ) : page.isPending ? (
              <div className="space-y-3 p-4">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
            ) : page.rows.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted">Nothing here{status ? ' for that filter' : ''}.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-canvas/60 text-xs tracking-wide text-muted uppercase">
                  <tr><th scope="col" className="px-4 py-2.5 font-semibold">Email</th><th scope="col" className="px-4 py-2.5 font-semibold">Name</th><th scope="col" className="px-4 py-2.5 font-semibold">Result</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {page.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-medium">{r.email}</td>
                      <td className="px-4 py-2.5 text-soft">{r.name ?? '—'}</td>
                      <td className="px-4 py-2.5"><Verdict l={r} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {page.hasNextPage && (
              <div className="flex justify-center border-t border-line p-3">
                <Button variant="ghost" size="sm" loading={page.isFetchingNextPage} onClick={() => void page.fetchNextPage()}>Load more</Button>
              </div>
            )}
          </div>

          <Modal
            open={confirm}
            onClose={() => setConfirm(false)}
            title={`Remove ${nf.format(l.counts.undeliverable)} undeliverable address${l.counts.undeliverable === 1 ? '' : 'es'}?`}
            footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Keep them</Button><Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate({ id, status: 'UNDELIVERABLE' }, { onSuccess: (r) => { toast.success(`Removed ${nf.format(r.removed)}`); setConfirm(false); }, onError: (e) => toast.error(e.message) })}>Remove</Button></>}
          >
            <p className="text-sm text-soft">They are taken out of this list only. You can always add addresses again.</p>
          </Modal>
        </>
      )}
    </div>
  );
}
