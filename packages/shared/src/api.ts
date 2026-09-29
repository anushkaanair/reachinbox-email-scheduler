import { z } from 'zod';

/** Every non-2xx response from the API has this shape. */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNAVAILABLE: 'UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.boolean(),
  redis: z.boolean(),
  elasticsearch: z.boolean(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Server-Sent Events pushed on /api/events (feature F1), scoped to the signed-in user. */
export type LiveEvent =
  | { type: 'email.updated'; emailId: string; campaignId: string; status: string }
  | { type: 'campaign.updated'; campaignId: string; status: string }
  | { type: 'ratelimit.hit'; senderEmail: string; scope: 'global' | 'sender' | 'campaign'; limit: number; retryAt: string };
