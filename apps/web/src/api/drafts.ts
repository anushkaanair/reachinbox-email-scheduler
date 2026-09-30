import { DraftSchema, DraftSummarySchema, type Draft, type DraftPayload } from '@ri/shared';
import { z, type ZodType } from 'zod';
import { api } from './client';

export const listDrafts = () => api('/drafts', { schema: z.array(DraftSummarySchema) });
// The schema fills in defaults, so what comes out is the full Draft even where the wire format could omit fields.
export const getDraft = (id: string) => api<Draft>(`/drafts/${id}`, { schema: DraftSchema as unknown as ZodType<Draft> });
export const createDraft = (payload: DraftPayload) => api('/drafts', { method: 'POST', body: payload, schema: DraftSummarySchema });
export const updateDraft = (id: string, payload: DraftPayload) => api(`/drafts/${id}`, { method: 'PUT', body: payload, schema: DraftSummarySchema });
export const deleteDraft = (id: string) => api(`/drafts/${id}`, { method: 'DELETE' });
