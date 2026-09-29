import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'neutral',
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'danger';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      <div
        className={cn(
          'mb-4 grid size-14 place-items-center rounded-2xl',
          tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600',
        )}
      >
        <Icon className="size-7" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
