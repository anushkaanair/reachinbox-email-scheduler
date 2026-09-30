import { format } from 'date-fns';
import { AlertTriangle, Gauge } from 'lucide-react';
import type { PreflightResponse } from '@ri/shared';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatWhen } from '@/lib/format';

const nf = new Intl.NumberFormat();
const SHOWN = 10;

const windowLabel = (iso: string, windowSeconds: number) =>
  format(new Date(iso), windowSeconds >= 86_400 ? 'EEE d MMM' : windowSeconds >= 3600 ? 'EEE h a' : 'h:mm a');

/**
 * "Send forecast": the lead report (valid / skipped) and a window-by-window chart of when the
 * emails will actually go out under the hourly limits and business hours.
 */
export function ForecastCard({
  data,
  loading,
  error,
  hasLeads,
}: {
  data: PreflightResponse | undefined;
  loading: boolean;
  error: Error | null;
  hasLeads: boolean;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5 md:p-6" aria-labelledby="forecast-h" aria-busy={loading}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="forecast-h" className="text-sm font-semibold tracking-wide text-muted uppercase">Send forecast</h2>
        {loading && data && <span className="text-xs text-muted">Updating…</span>}
      </div>

      {!hasLeads ? (
        <p className="py-6 text-center text-sm text-muted">Upload your leads to see when they’ll go out.</p>
      ) : error && !data ? (
        <p className="flex items-center gap-2 text-sm text-danger"><AlertTriangle className="size-4" /> Couldn’t compute the forecast: {error.message}</p>
      ) : !data ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}
        </div>
      ) : (
        <Body data={data} />
      )}
    </section>
  );
}

function Body({ data }: { data: PreflightResponse }) {
  const { forecast: f } = data;
  const max = Math.max(1, ...f.windows.map((w) => w.count));
  const shown = f.windows.slice(0, SHOWN);
  const first = f.windows[0];
  const limitedWindow = f.windows.find((w) => w.limited);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" aria-label="Lead report">
        <Badge tone="success">{nf.format(data.sendable)} will be sent</Badge>
        {data.suppressed > 0 && <Badge tone="warning">{nf.format(data.suppressed)} on do-not-contact list</Badge>}
        {data.recentlyEmailed > 0 && <Badge tone="warning">{nf.format(data.recentlyEmailed)} emailed recently</Badge>}
        {data.invalid > 0 && <Badge tone="danger">{nf.format(data.invalid)} invalid</Badge>}
        {data.duplicates > 0 && <Badge>{nf.format(data.duplicates)} duplicate{data.duplicates === 1 ? '' : 's'}</Badge>}
      </div>

      {data.sendable === 0 ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">Nothing left to send — every lead was skipped or invalid.</p>
      ) : (
        <>
          <ol className="flex flex-col gap-1.5" aria-label="Emails per sending window">
            {shown.map((w) => (
              <li key={w.start} className="grid grid-cols-[4.75rem_1fr_auto] items-center gap-2 text-xs">
                <span className="text-muted tabular-nums">{windowLabel(w.start, data.windowSeconds)}</span>
                <span className="h-3 overflow-hidden rounded-sm bg-canvas" aria-hidden>
                  <span
                    className="block h-full rounded-sm"
                    style={{ width: `${Math.max(2, (w.count / max) * 100)}%`, background: w.limited ? 'var(--c-st-deferred)' : 'var(--c-st-sent)' }}
                  />
                </span>
                <span className="min-w-16 text-right tabular-nums">
                  <b className="text-ink">{nf.format(w.count)}</b>
                  {w.carried > 0 && <span className="text-muted"> · {nf.format(w.carried)} waiting</span>}
                </span>
              </li>
            ))}
          </ol>
          {f.windowsTotal > shown.length && <p className="-mt-2 text-xs text-muted">+ {nf.format(f.windowsTotal - shown.length)} more window{f.windowsTotal - shown.length === 1 ? '' : 's'}</p>}

          {limitedWindow && first && (
            <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
              <Gauge className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Your limits allow about <b>{nf.format(first.count)}</b> emails per window, so the rest wait for the next window — in their original order. Nothing is dropped.
              </span>
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">First email</dt>
            <dd className="text-right font-medium">{f.firstSendAt ? formatWhen(f.firstSendAt) : '—'}</dd>
            <dt className="text-muted">Finishes</dt>
            <dd className="text-right font-medium">{f.finishAt ? `≈ ${formatWhen(f.finishAt)}` : 'a long way out'}</dd>
          </dl>
        </>
      )}
    </div>
  );
}
