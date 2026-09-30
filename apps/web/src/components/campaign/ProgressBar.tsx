import type { CampaignSummary } from '@ri/shared';

const nf = new Intl.NumberFormat();

/** Segment order and colours shared by the campaign bar and its legend. */
export const SEGMENTS = [
  { key: 'sent', label: 'Sent', color: 'var(--c-st-sent)' },
  { key: 'rateLimited', label: 'Deferred by limit', color: 'var(--c-st-deferred)' },
  { key: 'failed', label: 'Failed', color: 'var(--c-st-failed)' },
  { key: 'pending', label: 'Pending', color: 'var(--c-st-pending)' },
] as const;

export function segmentValues(c: CampaignSummary['counts']) {
  return { sent: c.sent, rateLimited: c.rateLimited, failed: c.failed, pending: c.scheduled + c.sending };
}

/** Stacked horizontal bar; 2px surface gaps between segments, text legend (never colour alone). */
export function ProgressBar({ counts, total }: { counts: CampaignSummary['counts']; total: number }) {
  const v = segmentValues(counts);
  const denom = Math.max(1, total - counts.cancelled);
  return (
    <div>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-canvas"
        role="img"
        aria-label={SEGMENTS.map((s) => `${s.label} ${v[s.key]}`).join(', ')}
      >
        {SEGMENTS.map((s) =>
          v[s.key] > 0 ? (
            <span
              key={s.key}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(v[s.key] / denom) * 100}%`, background: s.color }}
              title={`${s.label}: ${nf.format(v[s.key])}`}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="text-ink tabular-nums">{nf.format(v[s.key])}</span> {s.label}
          </li>
        ))}
        {counts.cancelled > 0 && (
          <li>
            <span className="text-ink tabular-nums">{nf.format(counts.cancelled)}</span> Cancelled
          </li>
        )}
      </ul>
    </div>
  );
}
