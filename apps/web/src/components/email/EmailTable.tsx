import { AlertTriangle, CalendarClock, ExternalLink, Send } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EmailRow, EmailTab } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatWhen, relative } from '@/lib/format';
import { Highlight } from '@/components/ui/Highlight';
import { EmailStatusCell } from './StatusBadge';

/** A row may carry search highlights (field → fragments with HL markers). */
export type TableRow = EmailRow & { highlights?: Record<string, string[]> };
type Column = { key: string; header: string; className?: string; cell: (row: TableRow) => ReactNode };

const recipient: Column = {
  key: 'email',
  header: 'Email',
  cell: (r) => (
    <div className="min-w-0">
      <p className="truncate font-medium text-ink">
        <Highlight text={r.highlights?.toEmail?.[0] ?? r.toEmail} />
      </p>
      <p className="truncate text-xs text-muted">from {r.senderEmail}</p>
    </div>
  ),
};

const subject: Column = {
  key: 'subject',
  header: 'Subject',
  className: 'max-w-[28rem]',
  cell: (r) => (
    <div className="min-w-0">
      <p className="truncate text-ink">
        <Highlight text={r.highlights?.subject?.[0] ?? r.subject} />
      </p>
      {r.highlights?.body?.[0] && (
        <p className="truncate text-xs text-muted">
          …<Highlight text={r.highlights.body[0]} />…
        </p>
      )}
    </div>
  ),
};

const status: Column = {
  key: 'status',
  header: 'Status',
  cell: (r) => <EmailStatusCell row={r} />,
};

const time = (label: string, pick: (r: EmailRow) => string | null): Column => ({
  key: 'time',
  header: label,
  className: 'whitespace-nowrap',
  cell: (r) => {
    const iso = pick(r);
    return (
      <div>
        <p className="text-ink tabular-nums">{formatWhen(iso)}</p>
        <p className="text-xs text-muted">{relative(iso)}</p>
      </div>
    );
  },
});

/** Column sets per tab — the only thing that differs between Scheduled and Sent (DRY). */
const COLUMNS: Record<EmailTab, Column[]> = {
  scheduled: [recipient, subject, time('Scheduled time', (r) => r.nextAttemptAt), status],
  sent: [
    recipient,
    subject,
    time('Sent time', (r) => r.sentAt ?? r.failedAt),
    status,
    {
      key: 'preview',
      header: '',
      cell: (r) =>
        r.previewUrl ? (
          <a
            href={r.previewUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
          >
            Preview <ExternalLink className="size-3" />
          </a>
        ) : null,
    },
  ],
};

const EMPTY: Record<EmailTab, { icon: typeof Send; title: string; description: string }> = {
  scheduled: {
    icon: CalendarClock,
    title: 'No scheduled emails',
    description: 'Compose a campaign and upload your leads. Queued emails will show up here.',
  },
  sent: {
    icon: Send,
    title: 'Nothing sent yet',
    description: 'Emails appear here once they go out, or if they fail after all retries.',
  },
};

export type EmailTableProps = {
  variant: EmailTab;
  rows: TableRow[];
  /** Opens the detail drawer. */
  onRowClick?: (row: TableRow) => void;
  /** Overrides the default empty state (e.g. "no search results"). */
  empty?: { title: string; description: string };
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
};

export function EmailTable({
  variant,
  rows,
  isLoading,
  error,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  empty,
  onRowClick,
}: EmailTableProps) {
  const columns = COLUMNS[variant];

  if (error && rows.length === 0) {
    return (
      <EmptyState
        tone="danger"
        icon={AlertTriangle}
        title="Couldn't load emails"
        description={error.message}
        action={<Button variant="secondary" onClick={onRetry}>Try again</Button>}
      />
    );
  }

  if (!isLoading && rows.length === 0) {
    const e = { ...EMPTY[variant], ...empty };
    return (
      <EmptyState
        icon={e.icon}
        title={e.title}
        description={e.description}
        action={
          variant === 'scheduled' && !empty ? (
            <Link to="/compose">
              <Button>Compose new email</Button>
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas/60 text-xs uppercase tracking-wide text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className="px-4 py-3 font-semibold">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {isLoading
              ? Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-4">
                        <Skeleton className="h-4 w-full max-w-40" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => onRowClick?.(row)}
                    onKeyDown={(e) => e.key === 'Enter' && onRowClick?.(row)}
                    tabIndex={onRowClick ? 0 : undefined}
                    aria-label={onRowClick ? `Open email to ${row.toEmail}` : undefined}
                    className={`transition-colors hover:bg-neutral-soft/60 ${onRowClick ? 'cursor-pointer focus-visible:bg-brand-50' : ''}`}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={`px-4 py-3 align-middle ${c.className ?? ''}`}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {hasNextPage && (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="ghost" size="sm" loading={isFetchingNextPage} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
