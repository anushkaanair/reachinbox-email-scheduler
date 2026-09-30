import {
  CreateCampaignResponseSchema,
  PreflightResponseSchema,
  SenderSchema,
  TestSendResponseSchema,
  type CreateCampaignInput,
  type PreflightInput,
  type TestSendInput,
} from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

export const createCampaign = (input: CreateCampaignInput, idempotencyKey: string) =>
  api('/campaigns', {
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': idempotencyKey },
    schema: CreateCampaignResponseSchema,
  });

export const fetchSenders = () => api('/senders', { schema: z.array(SenderSchema) });

export const preflight = (input: PreflightInput, signal?: AbortSignal) =>
  api('/campaigns/preflight', { method: 'POST', body: input, schema: PreflightResponseSchema, signal });

export const testSend = (input: TestSendInput) =>
  api('/campaigns/test-send', { method: 'POST', body: input, schema: TestSendResponseSchema });

export const retryFailed = (campaignId: string) =>
  api(`/campaigns/${campaignId}/retry-failed`, { method: 'POST', schema: z.object({ retried: z.number() }) });

/** Plain link: the browser downloads the CSV with the session cookie (no JS needed). */
export function exportUrl(filter: { tab?: 'scheduled' | 'sent'; campaignId?: string; status?: string }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) qs.set(k, v);
  return `/api/emails/export?${qs}`;
}
