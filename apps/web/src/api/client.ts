import { ApiErrorBodySchema } from '@ri/shared';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** When given, the response is validated at runtime — the API contract is enforced, not assumed. */
  schema?: ZodType<T>;
  signal?: AbortSignal;
};

/** Typed fetch wrapper. Same-origin (Vite proxy), so the httpOnly session cookie rides along. */
export async function api<T = void>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      signal: opts.signal,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Is the API running?');
  }

  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const parsed = ApiErrorBodySchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(res.status, code, message, details);
    }
    throw new ApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`);
  }

  return opts.schema ? opts.schema.parse(json) : (json as T);
}
