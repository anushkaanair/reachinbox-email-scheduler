import { ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_BOUNCE_PROTECTION, type SendWindow } from '@ri/shared';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Select } from '@/components/ui/Field';

export type Rules = {
  hoursOn: boolean;
  startHour: number;
  endHour: number;
  timezone: string;
  weekdaysOnly: boolean;
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
  skipOn: false, // off by default so re-sending the same test file isn't a surprise; one tick turns it on
  skipDays: 30,
  bounceOn: true,
  bounceThreshold: DEFAULT_BOUNCE_PROTECTION.thresholdPercent,
});

/** What the API gets: threshold 0 turns protection off. */
export const rulesToBounceProtection = (r: Rules) => ({ thresholdPercent: r.bounceOn ? r.bounceThreshold : 0, minSends: DEFAULT_BOUNCE_PROTECTION.minSends });

export const rulesToSendWindow = (r: Rules): SendWindow | undefined =>
  r.hoursOn ? { startHour: r.startHour, endHour: r.endHour, timezone: r.timezone, weekdaysOnly: r.weekdaysOnly } : undefined;

export const hoursError = (r: Rules) => (r.hoursOn && r.endHour <= r.startHour ? 'Closing time must be after opening time' : undefined);

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
