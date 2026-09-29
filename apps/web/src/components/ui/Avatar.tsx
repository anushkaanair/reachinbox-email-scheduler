import { useState } from 'react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

/** Google avatar with graceful fallback to initials (broken URL, blocked referrer, no photo). */
export function Avatar({ src, name, className }: { src?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const base = cn('size-9 shrink-0 rounded-full', className);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(base, 'object-cover ring-1 ring-line')}
      />
    );
  }
  return (
    <span
      aria-label={name}
      className={cn(base, 'grid place-items-center bg-brand-100 text-sm font-semibold text-brand-700')}
    >
      {initials(name) || '?'}
    </span>
  );
}
