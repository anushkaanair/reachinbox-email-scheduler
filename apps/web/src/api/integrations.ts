import { SearchResponseSchema, SlackStatusSchema, type EmailTab } from '@ri/shared';
import { api } from './client';

export function searchEmails(q: string, tab: EmailTab | undefined, signal?: AbortSignal) {
  const qs = new URLSearchParams({ q, size: '50' });
  if (tab) qs.set('status', tab);
  return api(`/emails/search?${qs}`, { schema: SearchResponseSchema, signal });
}

export const fetchSlackStatus = () => api('/slack', { schema: SlackStatusSchema });
export const sendSlackTest = () => api('/slack/test', { method: 'POST' });
export const disconnectSlack = () => api('/slack', { method: 'DELETE' });
/** Full-page navigation: OAuth needs real redirects. */
export const SLACK_CONNECT_URL = '/api/slack/connect';
