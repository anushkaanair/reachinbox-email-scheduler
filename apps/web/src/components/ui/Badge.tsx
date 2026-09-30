import type { ReactNode } from 'react';
import type { StatusTone } from '@ri/shared';
import { cn } from '@/lib/cn';

const tones: Record<StatusTone, string> = {
  neutral: 'bg-neutral-soft text-soft ring-line',
  info: 'bg-info-soft text-info ring-info-line',
  warning: 'bg-warn-soft text-warn ring-warn-line',
  success: 'bg-brand-50 text-brand-700 ring-brand-100',
  danger: 'bg-danger-soft text-danger ring-danger-line',
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
