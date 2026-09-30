import type { LeadCounts } from '@ri/shared';
import { cn } from '@/lib/cn';

const SEGMENTS: { key: keyof LeadCounts; label: string; bar: string; dot: string }[] = [
  { key: 'valid', label: 'Valid domain', bar: 'bg-st-sent', dot: 'bg-st-sent' },
  { key: 'risky', label: 'Risky', bar: 'bg-st-deferred', dot: 'bg-st-deferred' },
  { key: 'undeliverable', label: 'Undeliverable', bar: 'bg-st-failed', dot: 'bg-st-failed' },
  { key: 'unknown', label: 'Couldn’t check', bar: 'bg-neutral-strong', dot: 'bg-st-pending' },
  { key: 'unchecked', label: 'Not checked', bar: 'bg-neutral-soft', dot: 'bg-faint' },
];

const nf = new Intl.NumberFormat();

/** A stacked bar of the verdicts, with a legend that carries the numbers (colour is never the only signal). */
export function StatusBar({ counts, total, legend = true }: { counts: LeadCounts; total: number; legend?: boolean }) {
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-neutral-soft" role="img" aria-label={SEGMENTS.filter((s) => counts[s.key]).map((s) => `${nf.format(counts[s.key])} ${s.label.toLowerCase()}`).join(', ') || 'Empty list'}>
        {SEGMENTS.map((s) => (counts[s.key] > 0 ? <span key={s.key} className={cn('h-full', s.bar)} style={{ width: `${(counts[s.key] / Math.max(1, total)) * 100}%` }} /> : null))}
      </div>
      {legend && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span className={cn('size-2 rounded-full', s.dot)} aria-hidden />
              <span className="tabular-nums text-ink">{nf.format(counts[s.key])}</span> {s.label.toLowerCase()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
