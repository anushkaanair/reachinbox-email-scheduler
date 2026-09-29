import {
  CreateCampaignResponseSchema,
  SenderSchema,
  type CreateCampaignInput,
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
