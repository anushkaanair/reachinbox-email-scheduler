import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Native checkbox with a label and optional hint; the whole row is clickable. */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }
>(function Checkbox({ label, hint, className, id, ...rest }, ref) {
  const auto = useId();
  const cid = id ?? auto;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        ref={ref}
        id={cid}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-line accent-brand-600 focus-visible:ring-2 focus-visible:ring-brand-100"
        {...rest}
      />
      <label htmlFor={cid} className="cursor-pointer text-sm leading-snug text-ink select-none">
        {label}
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </label>
    </div>
  );
});
