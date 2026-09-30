import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { LiveEvent } from '@ri/shared';
import { formatWhen } from '@/lib/format';

// ── connection state, shared across the app (tiny external store) ──
let connected = false;
const listeners = new Set<() => void>();
const setConnected = (v: boolean) => {
  if (connected === v) return;
  connected = v;
  listeners.forEach((l) => l());
};
export const useLiveConnected = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => connected,
  );

/** Queries poll slowly while the live stream is up, and fall back to fast polling if it drops. */
export const livePollInterval = () => (connected ? 30_000 : 5_000);

const REFRESH_EVERY_MS = 400;

/**
 * Subscribes to /api/events (SSE). Bursts of events (1000 emails flipping status) are coalesced
 * into at most one refetch per 400 ms. EventSource reconnects on its own after drops/restarts.
 */
export function useLiveEvents() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource('/api/events', { withCredentials: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of [['emails'], ['campaigns'], ['analytics'], ['senders']]) void qc.invalidateQueries({ queryKey: key });
      }, REFRESH_EVERY_MS);
    };

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      let ev: LiveEvent;
      try {
        ev = JSON.parse(msg.data) as LiveEvent;
      } catch {
        return;
      }
      if (ev.type === 'ratelimit.hit') {
        const what = ev.scope === 'sender' || ev.scope === 'daily' ? ev.senderEmail : ev.scope === 'campaign' ? 'Campaign' : 'Global';
        toast.warning(`${ev.scope === 'daily' ? 'Warm-up daily limit' : 'Hourly limit'} reached · ${what}`, {
          description: `Limit ${ev.limit}/${ev.scope === 'daily' ? 'day' : 'hour'}. Remaining emails keep their order and resume ${formatWhen(ev.retryAt)}.`,
          duration: 8000,
        });
      }
      if (ev.type === 'sender.paused') {
        toast.error(`Sender paused · ${ev.senderEmail}`, {
          description: `${ev.reason} Its emails wait and resume ${formatWhen(ev.until)} (or resume it on the Email accounts page).`,
          duration: 10000,
        });
      }
      if (ev.type === 'campaign.auto_paused') {
        toast.error(`Campaign paused · ${ev.subject}`, {
          description: `${ev.bounceRate}% of addresses bounced (limit ${ev.threshold}%). Nothing was dropped. Clean the list, then resume it on the Campaigns page.`,
          duration: 12000,
        });
      }
      refresh();
    };

    return () => {
      if (timer) clearTimeout(timer);
      es.close();
      setConnected(false);
    };
  }, [qc]);
}
