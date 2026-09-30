import {
  AlertOctagon,
  ArrowLeft,
  Ban,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { EmailDetail, EmailEvent } from '@ri/shared';
import { useAssistant } from '@/components/assistant/AssistantProvider';
import { StarButton, StatusPill } from '@/components/email/EmailList';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useEmailAction, useEmailDetail } from '@/hooks/useInsights';
import { cn } from '@/lib/cn';
import { formatWhen } from '@/lib/format';

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
  if (e.type === 'RATE_LIMITED' && typeof m.retryAt === 'string') return `${String(m.scope)} limit ${String(m.limit)}/h · resumes ${formatWhen(m.retryAt)}`;
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
    <dd className="min-w-0 break-words text-ink">{children}</dd>
  </>
);

function Sender({ e }: { e: EmailDetail }) {
  const [open, setOpen] = useState(false);
  const when = e.sentAt ?? e.failedAt ?? e.scheduledAt;
  return (
    <div className="flex gap-4">
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-500 text-lg font-medium text-on-brand" aria-hidden>
        {e.senderEmail.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <p className="min-w-0 truncate">
            <span className="font-semibold">{e.senderEmail.split('@')[0]}</span> <span className="text-sm text-muted">&lt;{e.senderEmail}&gt;</span>
          </p>
          <time className="text-sm text-muted" dateTime={when}>{formatWhen(when)}</time>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="mt-0.5 flex items-center gap-1 text-sm text-muted hover:text-ink">
          to {e.toName ? e.toName : e.toEmail}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
        {open && (
          <dl className="mt-3 grid max-w-xl grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 rounded-xl border border-line p-4 text-sm">
            <Row label="From">{e.senderEmail}</Row>
            <Row label="To">{e.toName ? `${e.toName} <${e.toEmail}>` : e.toEmail}</Row>
            <Row label="Scheduled">{formatWhen(e.scheduledAt)}</Row>
            {e.status !== 'SENT' && e.status !== 'CANCELLED' && <Row label="Next attempt">{formatWhen(e.nextAttemptAt)}</Row>}
            {e.dispatchedAt && <Row label="Dispatched">{formatWhen(e.dispatchedAt)}</Row>}
            <Row label="Attempts">
              {e.attempts}
              {e.rateLimitedCount > 0 && ` · deferred ${e.rateLimitedCount}× by rate limits`}
            </Row>
            {e.messageId && <Row label="Message-ID"><span className="font-mono text-xs">{e.messageId}</span></Row>}
          </dl>
        )}
      </div>
    </div>
  );
}

/** One email as a full page (Figma): subject, star and trash, sender, message. Delivery details sit below. */
export function EmailDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: e, isPending, error } = useEmailDetail(id ?? null);
  const action = useEmailAction();
  const { askAbout } = useAssistant();

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/dashboard'));
  const pending = e && (e.status === 'SCHEDULED' || e.status === 'RATE_LIMITED');
  const run = (a: 'retry' | 'cancel') =>
    action.mutate({ id: e!.id, action: a }, { onSuccess: () => { toast.success(a === 'retry' ? 'Email re-queued' : 'Email cancelled'); if (a === 'cancel') back(); } });

  return (
    <article className="mx-auto max-w-5xl">
      <header className="flex items-start gap-3 border-b border-line pb-4">
        <button type="button" onClick={back} aria-label="Back" className="mt-1 rounded-full p-1.5 text-ink hover:bg-neutral-soft">
          <ArrowLeft className="size-5" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          {e ? <h1 className="text-2xl leading-snug font-medium break-words">{e.subject}</h1> : <Skeleton className="h-8 w-2/3" />}
        </div>
        {e && (
          <div className="flex shrink-0 items-center gap-1">
            <StarButton id={e.id} starred={e.starred} />
            {pending && (
              <button type="button" onClick={() => run('cancel')} disabled={action.isPending} aria-label="Cancel this email" title="Cancel this email" className="rounded-md p-1.5 text-muted hover:bg-neutral-soft hover:text-danger disabled:opacity-60">
                <Trash2 className="size-[18px]" aria-hidden />
              </button>
            )}
          </div>
        )}
      </header>

      {error ? (
        <EmptyState tone="danger" icon={AlertOctagon} title="Couldn’t open this email" description={error.message} action={<Button variant="secondary" onClick={back}>Go back</Button>} />
      ) : isPending || !e ? (
        <div className="mt-8 space-y-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
      ) : (
        <div className="mx-auto mt-8 max-w-3xl">
          <Sender e={e} />
          <div className="mt-8 pl-0 text-[15px] leading-relaxed whitespace-pre-wrap sm:pl-[3.75rem]">{e.body}</div>

          <section aria-labelledby="delivery-h" className="mt-12 rounded-2xl border border-line p-5 sm:ml-[3.75rem]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 id="delivery-h" className="text-sm font-semibold">Delivery</h2>
              <StatusPill row={e} />
              <div className="ml-auto flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" className="hover:text-accent" onClick={() => askAbout(`What happened to ${e.toEmail}?`, { emailId: e.id, campaignId: e.campaignId })}>
                  <Sparkles className="size-4 text-accent" aria-hidden /> Ask about this
                </Button>
                {e.status === 'FAILED' && (
                  <Button size="sm" loading={action.isPending} onClick={() => run('retry')}>
                    <RotateCcw className="size-4" /> Retry
                  </Button>
                )}
                {e.previewUrl && (
                  <a href={e.previewUrl} target="_blank" rel="noreferrer">
                    <Button variant="secondary" size="sm"><ExternalLink className="size-4" /> Open in Ethereal</Button>
                  </a>
                )}
              </div>
            </div>
            {e.status === 'FAILED' && e.lastError && <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm break-words text-danger">{e.lastError}</p>}
            <div className="mt-5"><Timeline events={e.events} /></div>
          </section>
        </div>
      )}
    </article>
  );
}
