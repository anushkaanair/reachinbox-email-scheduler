import { AlertTriangle, Ban, Layers, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { CampaignStatus, CampaignSummary, StatusTone } from '@ri/shared';
import type { CampaignAction } from '@/api/insights';
import { ProgressBar } from '@/components/campaign/ProgressBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCampaignAction, useCampaigns } from '@/hooks/useInsights';
import { formatWhen, relative } from '@/lib/format';

const STATUS_UI: Record<CampaignStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: 'Active', tone: 'info' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'success' },
};

const nf = new Intl.NumberFormat();

function CampaignCard({ c, onAction, busy }: { c: CampaignSummary; onAction: (a: CampaignAction) => void; busy: boolean }) {
  const s = STATUS_UI[c.status];
  const done = c.counts.sent + c.counts.failed;
  return (
    <article className="rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">{c.subject}</h2>
            <Badge tone={s.tone}>{s.label}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Created {relative(c.createdAt)} · starts {formatWhen(c.startAt)} · every {c.delayBetweenMs / 1000}s · max{' '}
            {nf.format(c.hourlyLimit)}/hour
          </p>
        </div>
        <div className="flex gap-2">
          {c.status === 'ACTIVE' && (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => onAction('pause')}>
              <Pause className="size-4" /> Pause
            </Button>
          )}
          {c.status === 'PAUSED' && (
            <Button size="sm" loading={busy} onClick={() => onAction('resume')}>
              <Play className="size-4" /> Resume
            </Button>
          )}
          {(c.status === 'ACTIVE' || c.status === 'PAUSED') && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction('cancel')}>
              <Ban className="size-4" /> Cancel
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-baseline justify-between text-sm">
        <span>
          <span className="font-semibold tabular-nums">{nf.format(done)}</span>
          <span className="text-muted"> / {nf.format(c.total)} processed</span>
        </span>
        {c.lastPendingAt && c.status === 'ACTIVE' && (
          <span className="text-xs text-muted">Finishes ≈ {formatWhen(c.lastPendingAt)}</span>
        )}
      </div>
      <div className="mt-2">
        <ProgressBar counts={c.counts} total={c.total} />
      </div>
    </article>
  );
}

/** Feature F3: campaign overview with live progress and Pause / Resume / Cancel. */
export function CampaignsPage() {
  const { data, isPending, error, refetch } = useCampaigns();
  const act = useCampaignAction();
  const [confirm, setConfirm] = useState<CampaignSummary | null>(null);

  const run = (c: CampaignSummary, action: CampaignAction) =>
    act.mutate(
      { id: c.id, action },
      { onSuccess: () => toast.success({ pause: 'Campaign paused', resume: 'Campaign resumed', cancel: 'Campaign cancelled' }[action]) },
    );

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-bold tracking-tight">Campaigns</h1>
      <p className="mb-5 text-sm text-muted">Live progress for every campaign. Pausing keeps each email’s place in line.</p>

      {error ? (
        <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load campaigns" description={error.message}
          action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>} />
      ) : isPending ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="rounded-xl border border-line bg-surface p-5">
              <Skeleton className="h-5 w-64" />
              <Skeleton className="mt-4 h-2.5 w-full" />
            </div>
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState icon={Layers} title="No campaigns yet" description="Compose an email and upload your leads to start one."
            action={<Link to="/compose"><Button>Compose new email</Button></Link>} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {data.map((c) => (
            <CampaignCard
              key={c.id}
              c={c}
              busy={act.isPending && act.variables?.id === c.id}
              onAction={(a) => (a === 'cancel' ? setConfirm(c) : run(c, a))}
            />
          ))}
        </div>
      )}

      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        title="Cancel campaign?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => { run(confirm!, 'cancel'); setConfirm(null); }}>
              Cancel {nf.format((confirm?.counts.scheduled ?? 0) + (confirm?.counts.rateLimited ?? 0))} pending emails
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Pending emails in “{confirm?.subject}” won’t be sent. Emails already sent are unaffected. This can’t be undone.
        </p>
      </Modal>
    </div>
  );
}
