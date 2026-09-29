import type { Redis } from 'ioredis';
import { AppError } from './errors.js';

const TTL_SEC = 24 * 3600;
const PENDING = '__pending__';

/**
 * Request-level idempotency (GODFATHER §5.4): the first request with a given Idempotency-Key runs;
 * repeats get the stored response; a concurrent duplicate gets 409. On failure the key is freed.
 */
export async function withIdempotency<T>(
  redis: Redis,
  scope: string,
  key: string | undefined,
  run: () => Promise<T>,
): Promise<{ replayed: boolean; body: T }> {
  if (!key) return { replayed: false, body: await run() };
  if (!/^[\w-]{8,128}$/.test(key)) throw new AppError(400, 'VALIDATION', 'Invalid Idempotency-Key header');

  const k = `idem:${scope}:${key}`;
  const claimed = await redis.set(k, PENDING, 'EX', TTL_SEC, 'NX');
  if (!claimed) {
    const existing = await redis.get(k);
    if (existing && existing !== PENDING) return { replayed: true, body: JSON.parse(existing) as T };
    throw new AppError(409, 'CONFLICT', 'This request is already being processed');
  }
  try {
    const body = await run();
    await redis.set(k, JSON.stringify(body), 'EX', TTL_SEC);
    return { replayed: false, body };
  } catch (err) {
    await redis.del(k);
    throw err;
  }
}
