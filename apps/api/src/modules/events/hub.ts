import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { LIVE_PATTERN } from '../../lib/live.js';
import { logger } from '../../lib/logger.js';
import { authedUserId } from '../auth/session.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events hub (feature F1). A single Redis pattern subscription per API process;
 * each message is forwarded only to that user's open connections. Started lazily on the first
 * client so tests and idle processes don't hold a subscriber connection.
 */
export class LiveHub {
  private readonly clients = new Map<string, Set<Response>>();
  private sub: Redis | null = null;

  constructor(private readonly makeSubscriber: () => Redis) {}

  private start() {
    if (this.sub) return;
    this.sub = this.makeSubscriber();
    void this.sub.psubscribe(LIVE_PATTERN);
    this.sub.on('pmessage', (_pattern, channel, message) => {
      const userId = channel.slice(channel.lastIndexOf(':') + 1);
      for (const res of this.clients.get(userId) ?? []) res.write(`data: ${message}\n\n`);
    });
  }

  /** GET /api/events */
  handler = (req: Request, res: Response) => {
    const userId = authedUserId(req);
    this.start();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n'); // browser reconnect delay
    res.write(': connected\n\n');

    const set = this.clients.get(userId) ?? new Set<Response>();
    set.add(res);
    this.clients.set(userId, set);

    // Comment pings keep proxies from closing an idle stream. Connection-scoped; never schedules work.
    const ping = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(ping);
      set.delete(res);
      if (set.size === 0) this.clients.delete(userId);
    });
  };

  async close(): Promise<void> {
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
    await this.sub?.quit().catch((err) => logger.warn({ err }, 'live hub subscriber close failed'));
    this.sub = null;
  }
}
