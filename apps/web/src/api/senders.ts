import { SenderDetailSchema, type WarmupUpdate } from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

export const fetchSenderHealth = () => api('/senders/health', { schema: z.array(SenderDetailSchema) });
export const resumeSender = (id: string) => api(`/senders/${id}/resume`, { method: 'POST' });
export const updateWarmup = (id: string, body: WarmupUpdate) => api(`/senders/${id}/warmup`, { method: 'PUT', body });
