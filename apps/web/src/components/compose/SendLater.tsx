import { Clock } from 'lucide-react';
import { addDays, format, setHours, setMinutes, startOfMinute } from 'date-fns';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { toLocalInput } from '@/lib/schedule';
import { cn } from '@/lib/cn';

const tomorrowAt = (h: number) => setMinutes(setHours(addDays(new Date(), 1), h), 0);
const PRESETS = [9, 10, 11, 15].map((h) => ({ label: `Tomorrow, ${format(tomorrowAt(h), 'h:mm a')}`, at: () => tomorrowAt(h) }));

/**
 * The clock button and "Send Later" popover from the Figma compose frame. `value` is the chosen start
 * time, or null to send straight away. Cancel discards the change; Done applies it.
 */
export function SendLater({ value, onChange }: { value: Date | null; onChange: (d: Date | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const show = () => {
    setDraft(value ? toLocalInput(value) : '');
    setError(undefined);
    setOpen(true);
  };

  const done = () => {
    if (!draft) return setError('Pick a date and time');
    const d = new Date(draft);
    if (Number.isNaN(d.getTime()) || d.getTime() < startOfMinute(new Date()).getTime()) return setError('That time has already passed');
    onChange(d);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : show())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `Scheduled for ${format(value, 'PPp')}. Change send time` : 'Send later'}
        className={cn('grid size-10 place-items-center rounded-full transition-colors hover:bg-neutral-soft', value ? 'bg-brand-50 text-brand-700' : 'text-brand-600')}
      >
        <Clock className="size-[22px]" aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="Send later" className="absolute right-0 z-30 mt-2 w-80 rounded-2xl border border-line bg-surface-solid p-5 shadow-xl">
          <h2 className="text-base font-medium">Send Later</h2>
          <label className="mt-4 block text-sm text-muted">
            <span className="sr-only">Pick date and time</span>
            <input
              type="datetime-local"
              value={draft}
              min={toLocalInput(new Date())}
              onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
              aria-invalid={Boolean(error)}
              className="h-10 w-full border-b border-line bg-transparent text-sm text-ink focus:border-brand-600 focus:outline-none"
            />
          </label>
          {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
          <ul className="mt-3 flex flex-col">
            {PRESETS.map((p) => (
              <li key={p.label}>
                <button type="button" onClick={() => { setDraft(toLocalInput(p.at())); setError(undefined); }} className="w-full rounded-md px-1 py-2 text-left text-sm hover:bg-neutral-soft">
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-end gap-2">
            {value && (
              <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="mr-auto text-sm text-muted hover:text-ink">
                Send now instead
              </button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="secondary" size="sm" className="rounded-full border-brand-600 text-brand-600" onClick={done}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}
