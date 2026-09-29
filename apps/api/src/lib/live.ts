import type { Redis } from 'ioredis';
import type { LiveEvent } from '@ri/shared';

/**
 * Live updates travel worker/API → Redis pub/sub → every API instance → the user's browser (SSE).
 * One channel per user keeps fan-out cheap and tenant-scoped by construction.
 */
export const LIVE_PATTERN = 'ri:live:*';
export const liveChannel = (userId: string) => `ri:live:${userId}`;

export async function publishLive(redis: Redis, userId: string, event: LiveEvent): Promise<void> {
  await redis.publish(liveChannel(userId), JSON.stringify(event));
}
