import {
  DnsReportSchema,
  SenderDetailSchema,
  type BulkAction,
  type ImportReport,
  type ImportRow,
  type Reconnect,
  type SenderCreateInput,
  type SenderSettings,
  type WarmupUpdate,
} from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

export const fetchSenderHealth = () => api('/senders/health', { schema: z.array(SenderDetailSchema) });
export const resumeSender = (id: string) => api(`/senders/${id}/resume`, { method: 'POST' });
export const updateWarmup = (id: string, body: WarmupUpdate) => api(`/senders/${id}/warmup`, { method: 'PUT', body });

export type ConnectInput = Omit<SenderCreateInput, 'verify'>;
export const connectAccount = (body: ConnectInput) => api<{ id: string; email: string }>('/senders', { method: 'POST', body });
export const importAccounts = (rows: ImportRow[], verify: boolean) => api<ImportReport>('/senders/import', { method: 'POST', body: { rows, verify } });
export const bulkAccounts = (body: BulkAction) => api<{ updated: number; skipped: { id: string; email: string; reason: string }[] }>('/senders/bulk', { method: 'POST', body });
export const updateSettings = (id: string, body: SenderSettings) => api(`/senders/${id}/settings`, { method: 'PUT', body });
export const testAccount = (id: string, to: string) => api<{ ok: boolean; previewUrl: string | null; error: string | null }>(`/senders/${id}/test`, { method: 'POST', body: { to } });
export const dnsCheck = (id: string) => api(`/senders/${id}/dns-check`, { method: 'POST', schema: DnsReportSchema });
export const reconnectAccount = (id: string, body: Reconnect) => api(`/senders/${id}/reconnect`, { method: 'POST', body });
export const acknowledgeAccount = (id: string) => api(`/senders/${id}/acknowledge`, { method: 'POST' });
