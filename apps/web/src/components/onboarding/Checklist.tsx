import { ArrowRight, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ChecklistStep } from '@ri/shared';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-soft" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-sm tabular-nums text-muted">{percent}%</span>
    </div>
  );
}

/** The setup steps with real completion state. The first unfinished required step gets the call to action. */
export function Checklist({ steps }: { steps: ChecklistStep[] }) {
  const nextId = steps.find((s) => !s.done && !s.optional)?.id;
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((s, i) => (
        <li key={s.id} className={cn('flex items-start gap-3 rounded-xl border p-4', s.done ? 'border-line bg-canvas/40' : s.id === nextId ? 'border-brand-600/40 bg-brand-50/50' : 'border-line bg-surface')}>
          <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold', s.done ? 'bg-brand-600 text-on-brand' : 'bg-neutral-soft text-muted')} aria-hidden>
            {s.done ? <Check className="size-4" /> : i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-medium', s.done && 'text-muted line-through decoration-1')}>
              {s.title}
              {s.optional && <span className="ml-2 text-xs font-normal text-muted no-underline">Optional</span>}
              <span className="sr-only">{s.done ? ' — done' : ' — not done yet'}</span>
            </p>
            <p className="mt-0.5 text-xs text-muted">{s.description}</p>
          </div>
          {!s.done && (
            <Link to={s.href} className={buttonClass(s.id === nextId ? 'primary' : 'secondary', 'sm', 'shrink-0')}>
              {s.cta} <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </li>
      ))}
    </ol>
  );
}
