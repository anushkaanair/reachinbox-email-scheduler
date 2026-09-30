import { AddSuppressionsResponseSchema, SuppressionListSchema } from '@ri/shared';
import { api } from './client';

export const listSuppressions = (q: string, limit = 50) =>
  api(`/suppressions?${new URLSearchParams({ ...(q ? { q } : {}), limit: String(limit) })}`, { schema: SuppressionListSchema });

export const addSuppressions = (emails: string[]) =>
  api('/suppressions', { method: 'POST', body: { emails }, schema: AddSuppressionsResponseSchema });

export const removeSuppression = (id: string) => api(`/suppressions/${id}`, { method: 'DELETE' });
