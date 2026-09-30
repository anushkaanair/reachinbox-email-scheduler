import {
  EmailCountsSchema,
  ListEmailsResponseSchema,
  type EmailTab,
  type ListEmailsResponse,
} from '@ri/shared';
import { api } from './client';

export type EmailFilters = { starred?: boolean; outcome?: 'SENT' | 'FAILED'; archived?: boolean };

export function listEmails(tab: EmailTab, cursor?: string, signal?: AbortSignal, filters: EmailFilters = {}) {
  const qs = new URLSearchParams({ status: tab, limit: '50' });
  if (cursor) qs.set('cursor', cursor);
  if (filters.starred) qs.set('starred', 'true');
  if (filters.archived) qs.set('archived', 'true');
  if (filters.outcome && tab === 'sent') qs.set('outcome', filters.outcome);
  return api<ListEmailsResponse>(`/emails?${qs}`, { schema: ListEmailsResponseSchema, signal });
}

export const fetchEmailCounts = () => api('/emails/counts', { schema: EmailCountsSchema });

export const starEmail = (id: string, starred: boolean) => api(`/emails/${id}/star`, { method: 'PUT', body: { starred } });
export const archiveEmail = (id: string, archived: boolean) => api(`/emails/${id}/archive`, { method: 'PUT', body: { archived } });
