import { Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Spinner } from '@/components/ui/Spinner';

/** The pill search field from the Figma frames. Press "/" anywhere to focus it, Esc to clear. */
export function SearchBar({
  value,
  onChange,
  loading,
  placeholder = 'Search',
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
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={ref}
        type="search"
        role="searchbox"
        aria-label="Search emails"
        aria-keyshortcuts="/"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={placeholder}
        className="h-11 w-full rounded-full bg-neutral-soft pr-12 pl-11 text-sm placeholder:text-muted focus:bg-surface focus:ring-2 focus:ring-brand-600/40 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute top-1/2 right-3 flex -translate-y-1/2 items-center gap-1">
        {loading && <Spinner className="size-4 text-muted" label="Searching" />}
        {value && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="rounded p-0.5 text-muted hover:text-ink">
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
