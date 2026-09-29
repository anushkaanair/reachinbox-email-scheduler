import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on its connections.
 * Workers need their own blocking connection, so callers create one per role via this factory.
 */
export function createRedis(role: string): Redis {
  const client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
  client.on('error', (err) => logger.error({ err, role }, 'redis error'));
  return client;
}

/** Shared connection for non-blocking commands (rate-limit Lua, health checks, idempotency keys). */
export const redis = createRedis('shared');
