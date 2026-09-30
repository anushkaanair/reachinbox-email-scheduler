import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

const control =
  'w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted/70 ' +
  'transition-colors focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 ' +
  'disabled:bg-canvas aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger-line';

type FieldShellProps = { id: string; label?: string; hint?: ReactNode; error?: string; children: ReactNode };

/** Label + control + hint/error — shared by every form control so they stay visually identical. */
function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-err`} className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

type Common = { label?: string; hint?: ReactNode; error?: string };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Common>(
  function Input({ label, hint, error, className, id, ...rest }, ref) {
    const auto = useId();
    const fid = id ?? auto;
    return (
      <FieldShell id={fid} label={label} hint={hint} error={error}>
        <input
          ref={ref}
          id={fid}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${fid}-err` : undefined}
          className={cn(control, 'h-10', className)}
          {...rest}
        />
      </FieldShell>
    );
  },
);

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & Common & { children: ReactNode }
>(function Select({ label, hint, error, className, id, children, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error}>
      <select
        ref={ref}
        id={fid}
        aria-invalid={Boolean(error)}
        className={cn(control, 'h-10 appearance-none bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat pr-9', className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        }}
        {...rest}
      >
        {children}
      </select>
    </FieldShell>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & Common
>(function Textarea({ label, hint, error, className, id, rows = 8, ...rest }, ref) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <FieldShell id={fid} label={label} hint={hint} error={error}>
      <textarea
        ref={ref}
        id={fid}
        rows={rows}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${fid}-err` : undefined}
        className={cn(control, 'py-2 leading-relaxed', className)}
        {...rest}
      />
    </FieldShell>
  );
});
