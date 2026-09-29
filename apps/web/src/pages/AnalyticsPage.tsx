import { format } from 'date-fns';
import { AlertTriangle, BarChart3, CheckCircle2, CircleAlert, Gauge, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import type { Analytics } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAnalytics } from '@/hooks/useInsights';
import { cn } from '@/lib/cn';

const nf = new Intl.NumberFormat();

/** Buckets are UTC hours; in e.g. IST (+5:30) they start at :30, so show minutes when present. */
const hourTick = (h: string) => {
  const d = new Date(h);
  return format(d, d.getMinutes() ? 'h:mm' : 'ha');
};

/** Status series: validated palette (see styles/index.css). Stack order bottom → top. */
const SERIES = [
  { key: 'sent', label: 'Sent', color: '#0b9a5b' },
  { key: 'rateLimited', label: 'Deferred by limit', color: '#e0a100' },
  { key: 'failed', label: 'Failed', color: '#b42318' },
] as const;

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-ink">{format(new Date(label as string), 'MMM d, h:mm a')}</p>
      {SERIES.map((s) => {
        const v = payload.find((p) => p.dataKey === s.key)?.value ?? 0;
        return (
          <p key={s.key} className="flex items-center gap-2 text-muted">
            <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="flex-1">{s.label}</span>
            <span className="font-medium text-ink tabular-nums">{nf.format(v)}</span>
          </p>
        );
      })}
    </div>
  );
}

function HourlyChart({ data }: { data: Analytics['hourly'] }) {
  const [asTable, setAsTable] = useState(false);
  const hasData = data.some((d) => d.sent + d.failed + d.rateLimited > 0);
  return (
    <section className="rounded-xl border border-line bg-surface p-5" aria-labelledby="hourly-h">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="hourly-h" className="text-sm font-semibold">Emails per hour</h2>
          <ul className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted" aria-label="Legend">
            {SERIES.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>

      {!hasData ? (
        <p className="py-16 text-center text-sm text-muted">No sends in this period yet.</p>
      ) : asTable ? (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th className="py-1.5 font-medium">Hour</th>
                {SERIES.map((s) => <th key={s.key} className="py-1.5 text-right font-medium">{s.label}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...data].reverse().filter((d) => d.sent + d.failed + d.rateLimited > 0).map((d) => (
                <tr key={d.hour}>
                  <td className="py-1.5">{format(new Date(d.hour), 'MMM d, h:mm a')}</td>
                  {SERIES.map((s) => <td key={s.key} className="py-1.5 text-right tabular-nums">{nf.format(d[s.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-64" role="img" aria-label="Stacked bar chart of sent, deferred and failed emails per hour">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke="#eef0f3" />
              <XAxis
                dataKey="hour"
                tickFormatter={hourTick}
                tick={{ fontSize: 11, fill: '#64748b' }}
                tickLine={false}
                axisLine={{ stroke: '#e5e7eb' }}
                minTickGap={16}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={false} width={40} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="a" fill={s.color} stroke="#fff" strokeWidth={2} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

function SenderMeters({ senders, windowSeconds }: { senders: Analytics['senders']; windowSeconds: number }) {
  const windowLabel = windowSeconds === 3600 ? 'this hour' : `this ${Math.round(windowSeconds / 60)}-min window`;
  return (
    <section className="rounded-xl border border-line bg-surface p-5" aria-labelledby="senders-h">
      <h2 id="senders-h" className="text-sm font-semibold">Sender quota</h2>
      <p className="mb-4 text-xs text-muted">Emails counted against each sender’s limit {windowLabel} (live from Redis).</p>
      <ul className="flex flex-col gap-4">
        {senders.map((s) => {
          const pct = Math.min(100, (s.used / Math.max(1, s.limit)) * 100);
          const state = s.used >= s.limit ? 'full' : pct >= 70 ? 'high' : 'ok';
          const Icon = state === 'full' ? CircleAlert : state === 'high' ? Gauge : CheckCircle2;
          return (
            <li key={s.id}>
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{s.email}</span>
                <span className={cn('flex shrink-0 items-center gap-1 text-xs', state === 'full' ? 'text-red-700' : state === 'high' ? 'text-amber-700' : 'text-muted')}>
                  <Icon className="size-3.5" aria-hidden />
                  <span className="font-medium text-ink tabular-nums">{s.used}/{s.limit}</span>
                  {state === 'full' ? 'limit reached' : state === 'high' ? 'near limit' : ''}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={s.limit} aria-valuenow={s.used} aria-label={`${s.email} quota`}>
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${pct}%`, background: state === 'full' ? '#b42318' : state === 'high' ? '#e0a100' : '#0b9a5b' }}
                />
              </div>
              <p className="mt-1 text-xs text-muted">{nf.format(s.sent24h)} sent in the selected period</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Feature F4. */
export function AnalyticsPage() {
  const [hours, setHours] = useState(24);
  const { data, isPending, error, refetch } = useAnalytics(hours);
  const t = data?.totals;
  const rate = t && t.sent + t.failed > 0 ? `${((t.sent / (t.sent + t.failed)) * 100).toFixed(1)}%` : '—';

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted">Throughput, rate-limit deferrals and sender quota. Updates live.</p>
        </div>
        <div className="w-40">
          <Select aria-label="Time range" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>Last 24 hours</option>
            <option value={72}>Last 3 days</option>
            <option value={168}>Last 7 days</option>
          </Select>
        </div>
      </div>

      {error ? (
        <EmptyState tone="danger" icon={AlertTriangle} title="Couldn’t load analytics" description={error.message}
          action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>} />
      ) : isPending || !data ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
          <Skeleton className="h-80" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Tile label="Sent" value={nf.format(data.totals.sent)} />
            <Tile label="Failed" value={nf.format(data.totals.failed)} />
            <Tile label="Deferred by limits" value={nf.format(data.totals.rateLimited)} hint="moved to a later window" />
            <Tile label="Pending now" value={nf.format(data.totals.pending)} />
            <Tile label="Delivery rate" value={rate} hint="sent ÷ (sent + failed)" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
            <HourlyChart data={data.hourly} />
            <SenderMeters senders={data.senders} windowSeconds={data.windowSeconds} />
          </div>
        </div>
      )}
    </div>
  );
}
