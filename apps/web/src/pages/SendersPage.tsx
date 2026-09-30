import { zodResolver } from '@hookform/resolvers/zod';
import {
  AlertTriangle,
  Flame,
  HeartPulse,
  Mailbox,
  PauseCircle,
  Play,
  RotateCcw,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  DEFAULT_WARMUP,
  WarmupSettingsSchema,
  type SenderDetail,
  type StatusTone,
  type WarmupSettings,
} from '@ri/shared';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { useResumeSender, useSenderHealth, useUpdateWarmup } from '@/hooks/useSenderHealth';
import { cn } from '@/lib/cn';
import { formatWhen } from '@/lib/format';

const nf = new Intl.NumberFormat();

const STATUS: Record<
  SenderDetail['health']['status'],
  { label: string; tone: StatusTone; ring: string }
> = {
  healthy: { label: 'Healthy', tone: 'success', ring: 'text-st-sent' },
  watch: { label: 'Watch', tone: 'warning', ring: 'text-st-deferred' },
  at_risk: { label: 'At risk', tone: 'danger', ring: 'text-st-failed' },
  paused: { label: 'Paused', tone: 'neutral', ring: 'text-muted' },
};

/** "day" in the UI: a real day normally, or the shortened demo-mode length. */
const dayUnit = (sec: number) =>
  sec === 86_400 ? 'day' : sec % 60 === 0 ? `${sec / 60}-min “day”` : `${sec}s “day”`;

/** Circular score gauge (SVG), coloured by status. */
function ScoreRing({ score, status }: { score: number; status: SenderDetail['health']['status'] }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <div
      className="relative grid size-16 shrink-0 place-items-center"
      role="img"
      aria-label={`Health score ${score} out of 100`}
    >
      <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--c-neutral-soft)" strokeWidth="5" />
        <circle
          cx="28"
          cy="28"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          className={cn('transition-[stroke-dasharray] duration-500', STATUS[status].ring)}
        />
      </svg>
      <span className="text-lg font-semibold tabular-nums">{score}</span>
    </div>
  );
}

/** Day-by-day warm-up caps; today highlighted, past days solid, future days faint. */
function RampChart({ s }: { s: SenderDetail }) {
  const { plan, day } = s.warmup;
  const max = Math.max(...plan.map((p) => p.cap));
  const shown = plan.slice(0, 30);
  return (
    <figure>
      <div
        className="flex h-24 items-end gap-1"
        role="img"
        aria-label={`Warm-up ramp: ${plan.map((p) => `day ${p.day} ${p.cap}`).join(', ')}`}
      >
        {shown.map((p) => {
          const isToday = day === p.day;
          const past = day !== null && p.day < day;
          return (
            <div
              key={p.day}
              className="flex h-full min-w-0 flex-1 flex-col justify-end"
              title={`Day ${p.day}: up to ${p.cap} emails`}
            >
              <div
                className={cn(
                  'w-full rounded-t-sm transition-colors',
                  isToday ? 'bg-accent' : past ? 'bg-st-sent' : 'bg-neutral-strong',
                )}
                style={{ height: `${Math.max(6, (p.cap / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1.5 flex justify-between text-[11px] text-muted">
        <span>Day 1 · {plan[0]?.cap}</span>
        <span>
          Day {plan.at(-1)?.day} · {plan.at(-1)?.cap} (full volume)
        </span>
      </figcaption>
    </figure>
  );
}

function WarmupEditor({ s, onDone }: { s: SenderDetail; onDone: () => void }) {
  const update = useUpdateWarmup();
  const form = useForm<WarmupSettings>({
    resolver: zodResolver(WarmupSettingsSchema),
    defaultValues: s.warmup.enabled ? s.warmup.settings : DEFAULT_WARMUP,
  });
  const e = form.formState.errors;
  const save = form.handleSubmit((settings) =>
    update.mutate(
      { id: s.id, body: { enabled: true, settings } },
      {
        onSuccess: () => {
          toast.success(s.warmup.enabled ? 'Warm-up updated' : `Warm-up started for ${s.email}`);
          onDone();
        },
      },
    ),
  );
  return (
    <form
      onSubmit={save}
      className="grid gap-3 rounded-lg border border-line bg-canvas/40 p-3 sm:grid-cols-3"
      noValidate
    >
      <Input
        type="number"
        min={1}
        label="Day 1"
        hint="emails"
        error={e.start?.message}
        {...form.register('start')}
      />
      <Input
        type="number"
        min={1}
        label="Add per day"
        hint="emails"
        error={e.increment?.message}
        {...form.register('increment')}
      />
      <Input
        type="number"
        min={1}
        label="Full volume"
        hint="emails/day"
        error={e.target?.message}
        {...form.register('target')}
      />
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" loading={update.isPending}>
          {s.warmup.enabled ? 'Save ramp' : 'Start warm-up'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SenderCard({ s }: { s: SenderDetail }) {
  const [editing, setEditing] = useState(false);
  const resume = useResumeSender();
  const update = useUpdateWarmup();
  const st = STATUS[s.health.status];
  const w = s.warmup;
  const unit = dayUnit(s.dayLengthSeconds);
  const attempts = s.stats.sent + s.stats.failed;

  return (
    <article
      className="rounded-xl border border-line bg-surface"
      aria-labelledby={`sender-${s.id}`}
    >
      <header className="flex flex-wrap items-center gap-4 border-b border-line p-5">
        <ScoreRing score={s.health.score} status={s.health.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`sender-${s.id}`} className="truncate text-base font-semibold">
              {s.email}
            </h2>
            <Badge tone={st.tone}>{st.label}</Badge>
            {w.enabled && !w.complete && (
              <Badge tone="warning">
                <Flame className="size-3" aria-hidden /> Warming up
              </Badge>
            )}
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
            {s.health.reasons.slice(0, 3).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <dl className="grid grid-cols-4 gap-x-5 text-right text-xs">
            {[
              ['Sent', s.stats.sent],
              ['Failed', s.stats.failed],
              ['Bounced', s.stats.hardBounces],
              ['Deferred', s.stats.deferred],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="text-muted">{k}</dt>
                <dd className="text-sm font-semibold tabular-nums">{nf.format(v as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-0.5 text-right text-[11px] text-muted">
            last {s.healthWindowDays} days
            {attempts ? ` · ${Math.round((s.stats.sent / attempts) * 100)}% delivered` : ''}
          </p>
        </div>
      </header>

      {s.pausedUntil && (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 border-b border-line bg-danger-soft px-5 py-3"
        >
          <PauseCircle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Paused until {formatWhen(s.pausedUntil)}</p>
            <p className="text-xs text-soft">
              {s.pauseReason?.replace(/\.?\s*$/, '.')} Its emails are waiting, not failing, and
              resume automatically.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={resume.isPending}
            onClick={() =>
              resume.mutate(s.id, { onSuccess: () => toast.success(`${s.email} resumed`) })
            }
          >
            <Play className="size-4" /> Resume now
          </Button>
        </div>
      )}

      <div className="grid gap-5 p-5 @3xl:grid-cols-2">
        <section aria-label="Current usage" className="flex flex-col gap-3">
          <UsageBar label={`This hour`} used={s.usedThisWindow} max={s.hourlyLimit} />
          <UsageBar
            label={`Today (this ${unit})`}
            used={s.sentToday}
            max={w.capToday ?? undefined}
            note={w.capToday === null ? 'no daily cap' : 'warm-up cap'}
          />
          {s.lastError && s.consecutiveFailures > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-danger">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">Last error: {s.lastError}</span>
            </p>
          )}
        </section>

        <section aria-labelledby={`warm-${s.id}`} className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 id={`warm-${s.id}`} className="flex items-center gap-1.5 text-sm font-semibold">
              <Flame className="size-4 text-warn" aria-hidden /> Warm-up ramp
            </h3>
            <Checkbox
              label="On"
              checked={w.enabled}
              disabled={update.isPending}
              onChange={(e) => {
                if (e.target.checked && !w.startedAt) setEditing(true);
                else
                  update.mutate(
                    { id: s.id, body: { enabled: e.target.checked } },
                    {
                      onSuccess: () =>
                        toast(e.target.checked ? 'Warm-up on' : 'Warm-up off — daily cap lifted'),
                    },
                  );
              }}
            />
          </div>

          {editing ? (
            <WarmupEditor s={s} onDone={() => setEditing(false)} />
          ) : w.enabled ? (
            <>
              <p className="text-sm">
                {w.complete ? (
                  <>Warm-up complete — sending at full volume.</>
                ) : (
                  <>
                    <b>Day {w.day}</b> of {w.plan.length} · up to <b>{w.capToday}</b> emails today ·{' '}
                    {s.sentToday} sent
                  </>
                )}
              </p>
              <RampChart s={s} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit ramp
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={update.isPending}
                  onClick={() =>
                    update.mutate(
                      { id: s.id, body: { enabled: true, restart: true } },
                      { onSuccess: () => toast('Warm-up restarted from day 1') },
                    )
                  }
                >
                  <RotateCcw className="size-4" /> Restart from day 1
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted">
              Off. New mailboxes should start slowly: turn this on to send a few emails on day 1 and
              a few more each {unit}, until full volume.
            </p>
          )}
        </section>
      </div>
    </article>
  );
}

function UsageBar({
  label,
  used,
  max,
  note,
}: {
  label: string;
  used: number;
  max?: number;
  note?: string;
}) {
  const pct = max ? Math.min(100, (used / Math.max(1, max)) * 100) : 0;
  const full = max !== undefined && used >= max;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className={cn('tabular-nums', full ? 'font-medium text-danger' : 'text-ink')}>
          {used}
          {max !== undefined ? ` / ${max}` : ''}{' '}
          {note && <span className="text-muted">· {note}</span>}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-neutral-soft"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max ?? used}
        aria-valuenow={used}
      >
        {max !== undefined && (
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-500',
              full ? 'bg-st-failed' : pct >= 80 ? 'bg-st-deferred' : 'bg-st-sent',
            )}
            style={{ width: `${Math.max(pct, used > 0 ? 3 : 0)}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** Sender health, warm-up ramps and circuit-breaker pauses. */
export function SendersPage() {
  const { data, isPending, error, refetch } = useSenderHealth();
  const counts = data?.reduce(
    (m, s) => ((m[s.health.status] = (m[s.health.status] ?? 0) + 1), m),
    {} as Record<string, number>,
  );
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Senders</h1>
          <p className="text-sm text-muted">
            Health of each sending account, warm-up ramps, and automatic pauses. Updates live.
          </p>
        </div>
        {counts && (
          <div className="flex flex-wrap gap-2" aria-label="Summary">
            {(['healthy', 'watch', 'at_risk', 'paused'] as const).map((k) =>
              counts[k] ? (
                <Badge key={k} tone={STATUS[k].tone}>
                  {counts[k]} {STATUS[k].label.toLowerCase()}
                </Badge>
              ) : null,
            )}
          </div>
        )}
      </div>

      {error ? (
        <EmptyState
          tone="danger"
          icon={AlertTriangle}
          title="Couldn’t load senders"
          description={error.message}
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : isPending ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-56 w-full rounded-xl" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            icon={Mailbox}
            title="No sending accounts yet"
            description="Run npm run senders:create -w @ri/api to add Ethereal senders."
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {data.map((s) => (
            <SenderCard key={s.id} s={s} />
          ))}
          <p className="flex items-start gap-2 text-xs text-muted">
            <HeartPulse className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Health is a heuristic from the last {data[0]!.healthWindowDays} days: failures, bounces
            and repeated errors lower it. A sender that fails several times in a row pauses itself
            and its emails wait.
          </p>
        </div>
      )}
    </div>
  );
}
