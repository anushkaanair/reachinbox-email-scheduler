import { format, formatDistanceToNowStrict, isToday, isTomorrow } from 'date-fns';

/** "Today, 3:40 PM" / "Tomorrow, 9:00 AM" / "Oct 4, 3:40 PM" */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isToday(d)) return `Today, ${format(d, 'h:mm a')}`;
  if (isTomorrow(d)) return `Tomorrow, ${format(d, 'h:mm a')}`;
  return format(d, 'MMM d, h:mm a');
}

export function relative(iso: string | null | undefined): string {
  return iso ? formatDistanceToNowStrict(new Date(iso), { addSuffix: true }) : '';
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** The time inside the orange list pill: "Tue 9:15:12 AM" for the coming week, a full date beyond that. */
export function pillWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = Math.abs(d.getTime() - Date.now()) / 86_400_000;
  return days < 6 ? format(d, 'EEE h:mm:ss a') : format(d, 'MMM d, h:mm a');
}
