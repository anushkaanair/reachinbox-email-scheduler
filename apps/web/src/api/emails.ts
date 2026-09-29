import {
  EmailCountsSchema,
  ListEmailsResponseSchema,
  type EmailTab,
  type ListEmailsResponse,
} from '@ri/shared';
import { api } from './client';

export function listEmails(tab: EmailTab, cursor?: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ status: tab, limit: '50' });
  if (cursor) qs.set('cursor', cursor);
  return api<ListEmailsResponse>(`/emails?${qs}`, { schema: ListEmailsResponseSchema, signal });
}

export const fetchEmailCounts = () => api('/emails/counts', { schema: EmailCountsSchema });
