import type { ReactNode } from 'react';
import type { StatusTone } from '@ri/shared';
import { cn } from '@/lib/cn';

const tones: Record<StatusTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  success: 'bg-brand-50 text-brand-700 ring-brand-100',
  danger: 'bg-red-50 text-red-700 ring-red-200',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  dot = true,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden />}
      {children}
    </span>
  );
}
