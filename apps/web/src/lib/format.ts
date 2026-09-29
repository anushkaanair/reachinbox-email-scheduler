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
