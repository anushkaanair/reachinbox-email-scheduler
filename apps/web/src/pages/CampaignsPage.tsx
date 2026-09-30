import { AlertTriangle, Ban, Download, Layers, Pause, Play, RotateCcw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { CampaignStatus, CampaignSummary, StatusTone } from '@ri/shared';
import type { CampaignAction } from '@/api/insights';
import { useAssistant } from '@/components/assistant/AssistantProvider';
import { ProgressBar } from '@/components/campaign/ProgressBar';
import { Badge } from '@/components/ui/Badge';
import { exportUrl } from '@/api/campaigns';
import { Button, buttonClass } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { useRetryFailed } from '@/hooks/useCompose';
import { useCampaignAction, useCampaigns } from '@/hooks/useInsights';
import { formatWhen, relative } from '@/lib/format';

const STATUS_UI: Record<CampaignStatus, { label: string; tone: StatusTone }> = {
  ACTIVE: { label: 'Active', tone: 'info' },
  PAUSED: { label: 'Paused', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  COMPLETED: { label: 'Completed', tone: 'success' },
};

const nf = new Intl.NumberFormat();

function CampaignCard({
  c,
  onAction,
  busy,
  onRetryFailed,
  retrying,
}: {
  c: CampaignSummary;
  onAction: (a: CampaignAction) => void;
  busy: boolean;
  onRetryFailed: () => void;
  retrying: boolean;
}) {
  const s = STATUS_UI[c.status];
  const { askAbout } = useAssistant();
  const done = c.counts.sent + c.counts.failed;
  return (
    <article className="rounded-xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">{c.subject}</h2>
            <Badge tone={s.tone}>{s.label}</Badge>
            {c.pauseReason === 'BOUNCE_PROTECTION' && <Badge tone="danger">Paused: bounce protection</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Created {relative(c.createdAt)} · starts {formatWhen(c.startAt)} · every {c.delayBetweenMs / 1000}s · max{' '}
            {nf.format(c.hourlyLimit)}/hour
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.counts.failed > 0 && c.status !== 'CANCELLED' && (
            <Button size="sm" variant="secondary" loading={retrying} onClick={onRetryFailed}>
              <RotateCcw className="size-4" /> Retry {nf.format(c.counts.failed)} failed
            </Button>
          )}
          <button
            type="button"
            onClick={() => askAbout(`How is #${c.id.slice(0, 8)} doing?`, { campaignId: c.id })}
            className={buttonClass('ghost', 'sm', 'hover:text-accent')}
            aria-label={`Ask Inbox about “${c.subject}”`}
          >
            <Sparkles className="size-4 text-accent" aria-hidden /> Ask
          </button>
          <a
            href={exportUrl({ campaignId: c.id })}
            download
            className={buttonClass('ghost', 'sm')}
            aria-label={`Export campaign “${c.subject}” as CSV`}
          >
            <Download className="size-4" /> Export
          </a>
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

      {c.pauseReason === 'BOUNCE_PROTECTION' && c.status === 'PAUSED' && (
        <p role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {c.bounceRate}% of addresses bounced (limit {c.bounceProtection.thresholdPercent}%), so this campaign paused itself to protect your senders. Nothing was dropped. Clean the list, then resume.
          </span>
        </p>
      )}
      {c.senderBlocked && (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {c.senderBlocked === 'PAUSED'
              ? 'Every sender with waiting emails is paused, so nothing goes out until one resumes (see Email accounts).'
              : 'The accounts these emails were assigned to were removed, so nothing will go out.'}
          </span>
        </p>
      )}

      <div className="mt-4 flex items-baseline justify-between text-sm">
        <span>
          <span className="font-semibold tabular-nums">{nf.format(done)}</span>
          <span className="text-muted"> / {nf.format(c.total)} processed</span>
          {c.bounced > 0 && <span className="ml-3 text-xs text-muted">{nf.format(c.bounced)} bounced{c.bounceRate !== null ? ` (${c.bounceRate}%)` : ''}</span>}
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
  const retry = useRetryFailed();
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
              retrying={retry.isPending && retry.variables === c.id}
              onRetryFailed={() =>
                retry.mutate(c.id, { onSuccess: (r) => toast.success(r.retried ? `Re-queued ${nf.format(r.retried)} failed email${r.retried === 1 ? '' : 's'}` : 'Nothing to retry') })
              }
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
