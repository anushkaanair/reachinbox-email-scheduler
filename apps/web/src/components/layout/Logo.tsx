import { cn } from '@/lib/cn';

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <img src="/favicon.svg" alt="" className="size-8" />
      <span className="text-lg font-bold tracking-tight text-ink">
        Reach<span className="text-brand-700">Inbox</span>
      </span>
    </div>
  );
}
