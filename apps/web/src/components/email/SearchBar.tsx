import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Spinner } from '@/components/ui/Spinner';

/** Search input; press "/" anywhere to focus it, Esc to clear. */
export function SearchBar({
  value,
  onChange,
  loading,
  placeholder = 'Search recipient, subject or body…',
}: {
  value: string;
  onChange: (v: string) => void;
  loading?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative w-full sm:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        aria-label="Search emails"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-line bg-surface pr-16 pl-9 text-sm placeholder:text-muted/70 focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
        {loading && <Spinner className="size-4 text-muted" label="Searching" />}
        {value ? (
          <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="rounded p-0.5 text-muted hover:text-ink">
            <X className="size-4" />
          </button>
        ) : (
          <kbd className="rounded border border-line px-1.5 text-[10px] text-muted">/</kbd>
        )}
      </div>
    </div>
  );
}
