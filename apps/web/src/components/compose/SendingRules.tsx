import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_BOUNCE_PROTECTION, MAX_SEND_LAYERS, type SendLayer, type SendWindow } from '@ri/shared';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Select } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

export type Rules = {
  hoursOn: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  weekdaysOnly: boolean;
  /** Day-specific hours that replace the main hours on the days they list. */
  layers: SendLayer[];
  skipOn: boolean;
  skipDays: number;
  /** Pause the campaign by itself when too many addresses bounce (on by default). */
  bounceOn: boolean;
  bounceThreshold: number;
};

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const defaultRules = (): Rules => ({
  hoursOn: false,
  startHour: 9,
  endHour: 17,
  timezone: browserZone(),
  weekdaysOnly: true,
  layers: [],
  skipOn: false, // off by default so re-sending the same test file isn't a surprise; one tick turns it on
  skipDays: 30,
  bounceOn: true,
  bounceThreshold: DEFAULT_BOUNCE_PROTECTION.thresholdPercent,
});

/** What the API gets: threshold 0 turns protection off. */
export const rulesToBounceProtection = (r: Rules) => ({ thresholdPercent: r.bounceOn ? r.bounceThreshold : 0, minSends: DEFAULT_BOUNCE_PROTECTION.minSends });

export const rulesToSendWindow = (r: Rules): SendWindow | undefined =>
  r.hoursOn ? { startHour: r.startHour, endHour: r.endHour, timezone: r.timezone, weekdaysOnly: r.weekdaysOnly, ...(r.layers.length ? { layers: r.layers } : {}) } : undefined;

export const hoursError = (r: Rules) => {
  if (!r.hoursOn) return undefined;
  if (r.endHour <= r.startHour) return 'Closing time must be after opening time';
  if (r.layers.some((l) => l.days.length === 0)) return 'Pick at least one day for each day-specific set of hours';
  if (r.layers.some((l) => l.endHour <= l.startHour)) return 'Closing time must be after opening time for each day-specific set of hours';
  return undefined;
};

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const COMMON_ZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

function allZones(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
  const list = supported?.length ? supported : COMMON_ZONES;
  return list.includes(current) ? list : [current, ...list];
}

const hourLabel = (h: number) => {
  if (h === 0) return '12:00 AM';
  if (h === 24) return '12:00 AM (midnight)';
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
};

/** Compose "sending rules": business-hours window and the do-not-contact / recently-emailed guard. */
export function SendingRules({ value, onChange, dncCount }: { value: Rules; onChange: (r: Rules) => void; dncCount?: number }) {
  const set = (patch: Partial<Rules>) => onChange({ ...value, ...patch });
  const zones = useMemo(() => allZones(value.timezone), [value.timezone]);
  const err = hoursError(value);

  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-1 text-sm font-semibold tracking-wide text-muted uppercase">Sending rules</legend>

      <Checkbox
        label="Only send during business hours"
        hint="Emails that would go out at night or on weekends wait for the next opening."
        checked={value.hoursOn}
        onChange={(e) => set({ hoursOn: e.target.checked })}
      />
      {value.hoursOn && (
        <div className="ml-6.5 flex flex-col gap-3 border-l-2 border-brand-100 pl-4">
          <div className="grid grid-cols-2 gap-3">
            <Select label="From" value={value.startHour} onChange={(e) => set({ startHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </Select>
            <Select label="Until" value={value.endHour} onChange={(e) => set({ endHour: Number(e.target.value) })} error={err}>
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </Select>
          </div>
          <Select label="Time zone" value={value.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>
            ))}
          </Select>
          <Checkbox label="Weekdays only (Mon–Fri)" checked={value.weekdaysOnly} onChange={(e) => set({ weekdaysOnly: e.target.checked })} />

          <div className="flex flex-col gap-3" role="group" aria-label="Day-specific hours">
            {value.layers.map((layer, i) => {
              const taken = new Set(value.layers.flatMap((l, j) => (j === i ? [] : l.days)));
              const patch = (p: Partial<SendLayer>) => set({ layers: value.layers.map((l, j) => (j === i ? { ...l, ...p } : l)) });
              return (
                <fieldset key={i} className="rounded-lg border border-line p-3">
                  <legend className="px-1 text-xs font-medium text-muted">Day-specific hours</legend>
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
                    {DAY_LETTERS.map((letter, d) => {
                      const on = layer.days.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          aria-label={DAY_NAMES[d]}
                          disabled={taken.has(d)}
                          onClick={() => patch({ days: on ? layer.days.filter((x) => x !== d) : [...layer.days, d].sort() })}
                          className={cn('size-8 rounded-full border text-xs font-medium transition-colors disabled:opacity-40', on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-muted hover:text-ink')}
                        >
                          {letter}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Select label="From" value={layer.startHour} onChange={(e) => patch({ startHour: Number(e.target.value) })}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={h}>{hourLabel(h)}</option>
                      ))}
                    </Select>
                    <Select label="Until" value={layer.endHour} onChange={(e) => patch({ endHour: Number(e.target.value) })}>
                      {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
                        <option key={h} value={h}>{hourLabel(h)}</option>
                      ))}
                    </Select>
                  </div>
                  <button type="button" onClick={() => set({ layers: value.layers.filter((_, j) => j !== i) })} className="mt-2 text-xs text-muted underline-offset-2 hover:text-danger hover:underline">
                    Remove
                  </button>
                </fieldset>
              );
            })}
            {value.layers.length < MAX_SEND_LAYERS && value.layers.flatMap((l) => l.days).length < 7 && (
              <button type="button" onClick={() => set({ layers: [...value.layers, { days: [], startHour: value.startHour, endHour: value.endHour }] })} className="w-fit text-sm font-medium text-brand-600 hover:underline">
                + Add day-specific hours
              </button>
            )}
            <p className="text-xs text-muted">For example, Fridays 9–1, or Saturday mornings. A day with its own hours uses those instead, even if it isn’t a weekday.</p>
          </div>
        </div>
      )}

      <Checkbox
        label="Skip people I already emailed recently"
        hint="Avoids double-contacting the same person across campaigns."
        checked={value.skipOn}
        onChange={(e) => set({ skipOn: e.target.checked })}
      />
      {value.skipOn && (
        <div className="ml-6.5 border-l-2 border-brand-100 pl-4">
          <Input
            type="number"
            min={1}
            max={365}
            label="Within the last (days)"
            value={value.skipDays}
            onChange={(e) => set({ skipDays: Math.min(365, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </div>
      )}

      <Checkbox
        label="Pause automatically if too many addresses bounce"
        hint={`Protects your senders’ reputation. Judged once at least ${DEFAULT_BOUNCE_PROTECTION.minSends} emails have been attempted; nothing is dropped, and you can resume it.`}
        checked={value.bounceOn}
        onChange={(e) => set({ bounceOn: e.target.checked })}
      />
      {value.bounceOn && (
        <div className="ml-6.5 border-l-2 border-brand-100 pl-4">
          <Input
            type="number"
            min={1}
            max={100}
            label="Pause when bounces exceed (%)"
            value={value.bounceThreshold}
            onChange={(e) => set({ bounceThreshold: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg bg-canvas/70 px-3 py-2 text-xs text-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-brand-600" aria-hidden />
        <span>
          People on your{' '}
          <Link to="/settings#do-not-contact" className="font-medium text-brand-700 underline underline-offset-2">
            do-not-contact list
          </Link>
          {dncCount !== undefined && ` (${dncCount})`} are always skipped.
        </span>
      </p>
    </fieldset>
  );
}
