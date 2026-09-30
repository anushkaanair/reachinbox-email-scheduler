import { LeadListSummarySchema, LeadPageSchema, LeadSchema, VerifyResultSchema, type CreateLeadList, type Lead, type LeadStatus } from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

export const listLeadLists = () => api('/lead-lists', { schema: z.array(LeadListSummarySchema) });
export const getLeadList = (id: string) => api(`/lead-lists/${id}`, { schema: LeadListSummarySchema });
export const createLeadList = (body: CreateLeadList) => api('/lead-lists', { method: 'POST', body, schema: LeadListSummarySchema });
export const deleteLeadList = (id: string) => api(`/lead-lists/${id}`, { method: 'DELETE' });
export const verifyLeadList = (id: string) => api(`/lead-lists/${id}/verify`, { method: 'POST', schema: VerifyResultSchema });
export const removeLeadsByStatus = (id: string, status: LeadStatus) => api(`/lead-lists/${id}/leads?status=${status}`, { method: 'DELETE', schema: z.object({ removed: z.number() }) });
export const fetchLeadPage = (id: string, status: string | undefined, cursor?: string) => {
  const qs = new URLSearchParams({ limit: '100' });
  if (status) qs.set('status', status);
  if (cursor) qs.set('cursor', cursor);
  return api(`/lead-lists/${id}/leads?${qs}`, { schema: LeadPageSchema });
};
// The schema may fill optional fields, so the parsed type is the plain Lead the composer uses.
export const fetchListRecipients = (id: string) => api<Lead[]>(`/lead-lists/${id}/recipients`, { schema: z.array(LeadSchema) as unknown as z.ZodType<Lead[]> });
export const leadListExportUrl = (id: string, status?: string) => `/api/lead-lists/${id}/export${status ? `?status=${status}` : ''}`;
