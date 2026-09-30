import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { DEFAULT_WARMUP, WarmupSettingsSchema, type SenderDetail, type StatusTone, type WarmupSettings } from '@ri/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useUpdateWarmup } from '@/hooks/useSenderHealth';
import { cn } from '@/lib/cn';

export const STATUS: Record<SenderDetail['health']['status'], { label: string; tone: StatusTone; ring: string }> = {
  healthy: { label: 'Healthy', tone: 'success', ring: 'text-st-sent' },
  watch: { label: 'Watch', tone: 'warning', ring: 'text-st-deferred' },
  at_risk: { label: 'At risk', tone: 'danger', ring: 'text-st-failed' },
  paused: { label: 'Paused', tone: 'neutral', ring: 'text-muted' },
};

/** "day" in the UI: a real day normally, or the shortened demo-mode length. */
export const dayUnit = (sec: number) => (sec === 86_400 ? 'day' : sec % 60 === 0 ? `${sec / 60}-min “day”` : `${sec}s “day”`);

/** Circular score gauge (SVG), coloured by status. */
export function ScoreRing({ score, status }: { score: number; status: SenderDetail['health']['status'] }) {
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
export function RampChart({ s }: { s: SenderDetail }) {
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

export function WarmupEditor({ s, onDone }: { s: SenderDetail; onDone: () => void }) {
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

export function UsageBar({
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

