import { addDays, addMinutes, format, setHours, setMinutes, startOfMinute } from 'date-fns';

/** Value format of <input type="datetime-local"> (local time, minute precision). */
export const toLocalInput = (d: Date) => format(startOfMinute(d), "yyyy-MM-dd'T'HH:mm");

export const QUICK_STARTS: { label: string; at: () => Date }[] = [
  { label: 'Now', at: () => new Date() },
  { label: 'In 15 min', at: () => addMinutes(new Date(), 15) },
  { label: 'In 1 hour', at: () => addMinutes(new Date(), 60) },
  { label: 'Tomorrow 9 AM', at: () => setMinutes(setHours(addDays(new Date(), 1), 9), 0) },
];

/**
 * Client-side ETA, mirroring the server's estimate (the server's figure is authoritative and is
 * shown after scheduling): bounded by the campaign's spacing and by hourly capacity.
 */
export function estimateFinish(n: number, start: Date, delaySec: number, hourlyLimit: number, senderCapacity: number) {
  if (n <= 0) return null;
  const perHour = Math.max(1, Math.min(hourlyLimit, senderCapacity || hourlyLimit));
  const bySpacing = (n - 1) * delaySec * 1000;
  const byHours = (Math.ceil(n / perHour) - 1) * 3_600_000;
  return new Date(start.getTime() + Math.max(bySpacing, byHours));
}
