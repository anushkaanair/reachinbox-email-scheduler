import {
  AnalyticsSchema,
  CampaignSummarySchema,
  EmailDetailSchema,
  HealthSchema,
} from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

export const fetchCampaigns = () => api('/campaigns', { schema: z.array(CampaignSummarySchema) });
export type CampaignAction = 'pause' | 'resume' | 'cancel';
export const campaignAction = (id: string, action: CampaignAction) =>
  api(`/campaigns/${id}/${action}`, { method: 'POST' });

export const fetchEmailDetail = (id: string) => api(`/emails/${id}`, { schema: EmailDetailSchema });
export const emailAction = (id: string, action: 'retry' | 'cancel') => api(`/emails/${id}/${action}`, { method: 'POST' });

export const fetchAnalytics = (hours: number) => api(`/analytics?hours=${hours}`, { schema: AnalyticsSchema });

/** Health returns 503 when degraded but still carries the body, so read it either way. */
export async function fetchHealth() {
  const res = await fetch('/api/health', { credentials: 'include' });
  return HealthSchema.parse(await res.json());
}
