import { AlertTriangle, CalendarClock, Clock, Send, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EmailRow, EmailTab } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Highlight } from '@/components/ui/Highlight';
import { Skeleton } from '@/components/ui/Skeleton';
import { useStar } from '@/hooks/useEmails';
import { cn } from '@/lib/cn';
import { pillWhen } from '@/lib/format';

/** A row may carry search highlights (field → fragments with HL markers). */
export type ListRow = EmailRow & { highlights?: Record<string, string[]> };

const pill = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

/**
 * The pill between recipient and subject. Scheduled mail shows when it will go out (orange, with a clock);
 * sent mail says "Sent"; everything else says what is going on in words.
 */
export function StatusPill({ row }: { row: Pick<EmailRow, 'status' | 'campaignStatus' | 'nextAttemptAt' | 'sentAt' | 'failedAt' | 'lastError'> }) {
  const pending = row.status === 'SCHEDULED' || row.status === 'RATE_LIMITED';
  if (pending && row.campaignStatus === 'PAUSED') return <span className={cn(pill, 'bg-neutral-soft text-soft ring-line')}>Paused</span>;
  if (pending || row.status === 'SENDING') {
    const deferred = row.status === 'RATE_LIMITED';
    return (
      <span
        className={cn(pill, 'bg-warn-soft text-warn ring-warn-line')}
        title={deferred ? 'Held back by a sending limit; resumes at this time' : row.status === 'SENDING' ? 'Sending now' : 'Scheduled to go out at this time'}
      >
        <Clock className="size-3.5" aria-hidden />
        <span className="sr-only">{deferred ? 'Resumes' : 'Scheduled for'} </span>
        {row.status === 'SENDING' ? 'Sending…' : pillWhen(row.nextAttemptAt)}
      </span>
    );
  }
  if (row.status === 'SENT') return <span className={cn(pill, 'bg-neutral-soft text-soft ring-line')}>Sent</span>;
  if (row.status === 'FAILED') return <span className={cn(pill, 'bg-danger-soft text-danger ring-danger-line')} title={row.lastError ?? undefined}>Failed</span>;
  return <span className={cn(pill, 'bg-neutral-soft text-soft ring-line')}>Cancelled</span>;
}

export function StarButton({ id, starred, className }: { id: string; starred: boolean; className?: string }) {
  const star = useStar();
  // Show the tap instantly; the list refetches when the server has it.
  const on = star.isPending ? !starred : starred;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? 'Remove star' : 'Star this email'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        star.mutate({ id, starred: !starred });
      }}
      className={cn('rounded-md p-1.5 text-muted transition-colors hover:bg-neutral-soft hover:text-ink', on && 'text-warn', className)}
    >
      <Star className="size-[18px]" fill={on ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
}

const EMPTY: Record<EmailTab, { icon: typeof Send; title: string; description: string }> = {
  scheduled: { icon: CalendarClock, title: 'No scheduled emails', description: 'Compose a campaign and upload your leads. Queued emails will show up here.' },
  sent: { icon: Send, title: 'Nothing sent yet', description: 'Emails appear here once they go out, or if they fail after all retries.' },
};

const recipientName = (r: EmailRow) => r.toName?.trim() || r.toEmail;

export type EmailListProps = {
  variant: EmailTab;
  rows: ListRow[];
  empty?: { title: string; description: string };
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
};

/** Flat rows, as in the Figma frames: To · status pill · bold subject with a grey preview · star. */
export function EmailList({ variant, rows, isLoading, error, onRetry, hasNextPage, isFetchingNextPage, onLoadMore, empty }: EmailListProps) {
  if (error && rows.length === 0) {
    return <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load emails" description={error.message} action={<Button variant="secondary" onClick={onRetry}>Try again</Button>} />;
  }
  if (!isLoading && rows.length === 0) {
    const e = { ...EMPTY[variant], ...empty };
    return (
      <EmptyState
        icon={e.icon}
        title={e.title}
        description={e.description}
        action={variant === 'scheduled' && !empty ? <Link to="/compose"><Button>Compose new email</Button></Link> : undefined}
      />
    );
  }
  return (
    <div>
      <ul className="divide-y divide-line border-y border-line" aria-label={variant === 'scheduled' ? 'Scheduled emails' : 'Sent emails'} aria-busy={isLoading}>
        {isLoading
          ? Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="flex items-center gap-4 px-3 py-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-6 w-28 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))
          : rows.map((r) => (
              <li key={r.id} className="group relative flex items-center gap-x-4 px-3 py-3.5 transition-colors hover:bg-neutral-soft/70">
                <Link to={`/email/${r.id}`} className="absolute inset-0 z-0 rounded focus-visible:outline-2 focus-visible:outline-brand-600" aria-label={`Open email to ${recipientName(r)}: ${r.subject}`} />
                <span className="pointer-events-none z-10 w-44 shrink-0 truncate text-sm sm:w-56">
                  <span className="text-ink">To: </span>
                  <Highlight text={r.highlights?.toEmail?.[0] ?? recipientName(r)} />
                </span>
                <span className="pointer-events-none z-10 shrink-0"><StatusPill row={r} /></span>
                <span className="pointer-events-none z-10 min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium text-ink">
                    <Highlight text={r.highlights?.subject?.[0] ?? r.subject} />
                  </span>
                  {(r.highlights?.body?.[0] || r.preview) && (
                    <span className="text-muted">
                      {' - '}
                      {r.highlights?.body?.[0] ? <Highlight text={r.highlights.body[0]} /> : r.preview}
                    </span>
                  )}
                </span>
                {r.status === 'FAILED' && r.lastError && <span className="pointer-events-none z-10 hidden max-w-48 truncate text-xs text-danger lg:block" title={r.lastError}>{r.lastError}</span>}
                <StarButton id={r.id} starred={r.starred} className="relative z-10" />
              </li>
            ))}
      </ul>
      {hasNextPage && (
        <div className="flex justify-center p-3">
          <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={onLoadMore}>Load more</Button>
        </div>
      )}
    </div>
  );
}
