import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

const variants = {
  // brand-600 keeps white label text ≥ 4.5:1 (WCAG AA); brand-500 is for non-text fills only.
  primary: 'glow-brand bg-brand-600 text-on-brand shadow-sm hover:bg-brand-700 active:bg-brand-700',
  secondary: 'bg-surface text-ink border border-line hover:bg-neutral-soft',
  ghost: 'text-muted hover:bg-neutral-soft hover:text-ink',
  danger: 'bg-danger-solid text-on-danger hover:bg-danger-strong',
} as const;

const sizes = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2.5',
} as const;

/** Same look as <Button>, for real links (a link containing a button is invalid HTML). */
export function buttonClass(variant: keyof typeof variants = 'secondary', size: keyof typeof sizes = 'md', className?: string) {
  return cn('inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors', variants[variant], sizes[size], className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
});
