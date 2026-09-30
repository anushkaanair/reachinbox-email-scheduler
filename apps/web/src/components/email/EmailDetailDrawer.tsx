import {
  AlertOctagon,
  Ban,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { EmailDetail, EmailEvent } from '@ri/shared';
import { useAssistant } from '@/components/assistant/AssistantProvider';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { Skeleton } from '@/components/ui/Skeleton';
import { useEmailAction, useEmailDetail } from '@/hooks/useInsights';
import { cn } from '@/lib/cn';
import { formatWhen } from '@/lib/format';
import { EmailStatusCell } from './StatusBadge';

const EVENT_UI: Record<EmailEvent['type'], { icon: LucideIcon; label: string; tone: string }> = {
  SCHEDULED: { icon: CalendarClock, label: 'Scheduled', tone: 'text-info bg-info-soft' },
  RATE_LIMITED: { icon: Gauge, label: 'Hourly limit reached — deferred', tone: 'text-warn bg-warn-soft' },
  SEND_ERROR: { icon: TriangleAlert, label: 'Send attempt failed — will retry', tone: 'text-warn bg-warn-soft' },
  SENT: { icon: CheckCircle2, label: 'Sent', tone: 'text-brand-700 bg-brand-50' },
  FAILED: { icon: AlertOctagon, label: 'Failed', tone: 'text-danger bg-danger-soft' },
  RETRIED: { icon: RotateCcw, label: 'Retried manually', tone: 'text-info bg-info-soft' },
  CANCELLED: { icon: Ban, label: 'Cancelled', tone: 'text-soft bg-neutral-soft' },
  PAUSED: { icon: Pause, label: 'Campaign paused', tone: 'text-soft bg-neutral-soft' },
  RESUMED: { icon: Play, label: 'Campaign resumed', tone: 'text-info bg-info-soft' },
};

function eventDetail(e: EmailEvent): string | null {
  const m = e.meta ?? {};
  if (e.type === 'RATE_LIMITED' && typeof m.retryAt === 'string')
    return `${String(m.scope)} limit ${String(m.limit)}/h · resumes ${formatWhen(m.retryAt)}`;
  if ((e.type === 'FAILED' || e.type === 'SEND_ERROR') && m.error) return String(m.error);
  if (e.type === 'SENT' && m.sender) return `via ${String(m.sender)}`;
  return null;
}

function Timeline({ events }: { events: EmailEvent[] }) {
  return (
    <ol className="relative ml-3 border-l border-line">
      {events.map((e, i) => {
        const ui = EVENT_UI[e.type];
        const detail = eventDetail(e);
        return (
          <li key={i} className="mb-4 ml-5 last:mb-0">
            <span className={cn('absolute -left-3 grid size-6 place-items-center rounded-full ring-4 ring-surface', ui.tone)}>
              <ui.icon className="size-3.5" aria-hidden />
            </span>
            <p className="text-sm font-medium">{ui.label}</p>
            <p className="text-xs text-muted">
              {formatWhen(e.at)}
              {detail && <> · {detail}</>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <dt className="text-muted">{label}</dt>
    <dd className="min-w-0 truncate text-ink">{children}</dd>
  </>
);

function Body({ e }: { e: EmailDetail }) {
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-sm">
        <Row label="To">{e.toName ? `${e.toName} <${e.toEmail}>` : e.toEmail}</Row>
        <Row label="From">{e.senderEmail}</Row>
        <Row label="Scheduled">{formatWhen(e.scheduledAt)}</Row>
        {e.status !== 'SENT' && e.status !== 'CANCELLED' && <Row label="Next attempt">{formatWhen(e.nextAttemptAt)}</Row>}
        {e.dispatchedAt && <Row label="Dispatched">{formatWhen(e.dispatchedAt)}</Row>}
        {e.sentAt && <Row label="Sent">{formatWhen(e.sentAt)}</Row>}
        <Row label="Attempts">
          {e.attempts}
          {e.rateLimitedCount > 0 && ` · deferred ${e.rateLimitedCount}× by rate limits`}
        </Row>
        {e.messageId && (
          <Row label="Message-ID">
            <span className="font-mono text-xs" title={e.messageId}>{e.messageId}</span>
          </Row>
        )}
      </dl>

      <section aria-labelledby="body-h">
        <h3 id="body-h" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Message</h3>
        <div className="rounded-lg border border-line bg-canvas/50 p-4 text-sm leading-relaxed whitespace-pre-wrap">{e.body}</div>
      </section>

      <section aria-labelledby="tl-h">
        <h3 id="tl-h" className="mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Timeline</h3>
        <Timeline events={e.events} />
      </section>
    </div>
  );
}

/** Feature F5: full email, Ethereal preview, status timeline and per-email actions. */
export function EmailDetailDrawer({ emailId, onClose }: { emailId: string | null; onClose: () => void }) {
  const { data: e, isPending, error } = useEmailDetail(emailId);
  const action = useEmailAction();
  const { askAbout } = useAssistant();
  const run = (a: 'retry' | 'cancel') =>
    action.mutate({ id: emailId!, action: a }, { onSuccess: () => toast.success(a === 'retry' ? 'Email re-queued' : 'Email cancelled') });

  const pending = e && (e.status === 'SCHEDULED' || e.status === 'RATE_LIMITED');

  return (
    <Drawer
      open={Boolean(emailId)}
      onClose={onClose}
      title={
        e ? (
          <div className="flex flex-col gap-1.5">
            <h2 className="truncate text-lg font-semibold">{e.subject}</h2>
            <EmailStatusCell row={e} />
          </div>
        ) : (
          <Skeleton className="h-6 w-56" />
        )
      }
      footer={
        e && (
          <>
            <Button
              variant="ghost"
              className="mr-auto hover:text-accent"
              onClick={() => {
                onClose();
                askAbout(`What happened to ${e.toEmail}?`, { emailId: e.id, campaignId: e.campaignId });
              }}
            >
              <Sparkles className="size-4 text-accent" aria-hidden /> Ask about this
            </Button>
            {pending && (
              <Button variant="ghost" loading={action.isPending} onClick={() => run('cancel')}>
                <Ban className="size-4" /> Cancel email
              </Button>
            )}
            {e.status === 'FAILED' && (
              <Button loading={action.isPending} onClick={() => run('retry')}>
                <RotateCcw className="size-4" /> Retry
              </Button>
            )}
            {e.previewUrl && (
              <a href={e.previewUrl} target="_blank" rel="noreferrer">
                <Button variant="secondary">
                  <ExternalLink className="size-4" /> Open in Ethereal
                </Button>
              </a>
            )}
          </>
        )
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error.message}</p>
      ) : isPending || !e ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}
        </div>
      ) : (
        <Body e={e} />
      )}
    </Drawer>
  );
}
