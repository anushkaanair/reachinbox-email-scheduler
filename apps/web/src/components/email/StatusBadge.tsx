import { STATUS_META, type EmailRow, type EmailStatus } from '@ri/shared';
import { Badge } from '@/components/ui/Badge';
import { formatWhen } from '@/lib/format';

export function StatusBadge({ status }: { status: EmailStatus }) {
  const meta = STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/**
 * Status plus the context a user actually needs: when a deferred email resumes, that its
 * campaign is paused, or why it failed.
 */
export function EmailStatusCell({
  row,
}: {
  row: Pick<EmailRow, 'status' | 'campaignStatus' | 'nextAttemptAt' | 'lastError'>;
}) {
  const pending = row.status === 'SCHEDULED' || row.status === 'RATE_LIMITED';
  if (pending && row.campaignStatus === 'PAUSED') {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge tone="neutral">Paused</Badge>
        <span className="text-xs text-muted">Campaign paused</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge status={row.status} />
      {row.status === 'RATE_LIMITED' && (
        <span className="text-xs whitespace-nowrap text-warn">Resumes {formatWhen(row.nextAttemptAt)}</span>
      )}
      {row.status === 'FAILED' && row.lastError && (
        <span className="max-w-48 truncate text-xs text-danger" title={row.lastError}>
          {row.lastError}
        </span>
      )}
    </div>
  );
}
