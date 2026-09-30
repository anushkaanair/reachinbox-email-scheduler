import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from './errors.js';

/** OAuth codes/state and tokens must never reach log files (S1). */
const SENSITIVE_PARAMS = /([?&](?:code|state|token|access_token|id_token)=)[^&#]*/gi;
export const redactUrl = (url: string | undefined) => (url ?? '').replace(SENSITIVE_PARAMS, '$1[redacted]');

/**
 * What request logs may contain. Deliberately minimal: no request or response headers, because
 * those carry the session cookie (`Cookie` / `Set-Cookie`) and any auth tokens.
 */
export const requestLogSerializers = {
  req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
  res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
};

/**
 * Request throttling for abuse-prone endpoints (S4) — distinct from the email send limiter.
 * Redis fixed window, so it holds across API instances. Fails open if Redis is unavailable:
 * throttling must never take the API down.
 */
export function requestLimit(
  redis: Redis,
  opts: { name: string; limit: number; windowSec: number; key: (req: Parameters<RequestHandler>[0]) => string },
): RequestHandler {
  return async (req, res, next) => {
    try {
      const bucket = Math.floor(Date.now() / 1000 / opts.windowSec);
      const k = `reqlimit:${opts.name}:${opts.key(req)}:${bucket}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, opts.windowSec);
      res.setHeader('RateLimit-Limit', String(opts.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - n)));
      if (n > opts.limit) {
        const retry = opts.windowSec - (Math.floor(Date.now() / 1000) % opts.windowSec);
        res.setHeader('Retry-After', String(retry));
        return next(new AppError(429, 'RATE_LIMITED', `Too many requests, try again in ${retry}s`));
      }
      next();
    } catch {
      next();
    }
  };
}
