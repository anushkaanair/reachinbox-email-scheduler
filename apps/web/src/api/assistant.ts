import { AssistantReplySchema, type AssistantContext } from '@ri/shared';
import { z } from 'zod';
import { api } from './client';

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const askAssistant = (message: string, context?: AssistantContext) =>
  api('/assistant/message', { method: 'POST', body: { message, context, timezone: timezone() }, schema: AssistantReplySchema });

export const confirmAssistantAction = (id: string) =>
  api(`/assistant/actions/${id}/confirm`, { method: 'POST', schema: AssistantReplySchema });

export const declineAssistantAction = (id: string) =>
  api(`/assistant/actions/${id}/cancel`, { method: 'POST', schema: AssistantReplySchema });

export const fetchStarters = () => api('/assistant/starters', { schema: z.object({ suggestions: z.array(z.string()) }) });
