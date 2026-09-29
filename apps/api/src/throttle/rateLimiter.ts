import type { Redis } from 'ioredis';

/**
 * Throttling for the email worker (GODFATHER §6). All state lives in Redis and every decision is
 * one atomic Lua call, so it is safe across any number of workers/processes.
 *
 * `acquire` does two things at once, per sender:
 *   1. SLOT: reserves the sender's next free send time = max(now, nextFree); nextFree += minDelay.
 *      → guarantees ≥ minDelay between any two sends from the same sender.
 *   2. QUOTA: counts the send against the window that *slot* falls in, for three scopes:
 *      global, sender, campaign. All-or-none: either all three counters increment or none do.
 *
 * If any scope is full, nothing is reserved and the caller gets `retryAt` in the next window,
 * offset by an overflow rank (INCR per scope+window) × minDelay — so jobs that overflowed first
 * retry first (FIFO preserved as far as possible), instead of stampeding at the window boundary.
 */
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local winMs = tonumber(ARGV[2])
local minDelay = tonumber(ARGV[3])
local lims = { tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]) }
local p, sid, cid = ARGV[7], ARGV[8], ARGV[9]
local ttl = tonumber(ARGV[10])

local nextFree = tonumber(redis.call('GET', KEYS[1]) or '0')
local slot = math.max(now, nextFree)
local w = math.floor(slot / winMs)
local ids = { 'all', sid, cid }
local scopes = { 'g', 's', 'c' }

for i = 1, 3 do
  local c = tonumber(redis.call('GET', p .. 'rl:' .. scopes[i] .. ':' .. ids[i] .. ':' .. w) or '0')
  if c >= lims[i] then
    local ov = p .. 'rl:ov:' .. scopes[i] .. ':' .. ids[i] .. ':' .. (w + 1)
    local rank = redis.call('INCR', ov)
    redis.call('EXPIRE', ov, ttl)
    return { 0, i, (w + 1) * winMs + (rank - 1) * minDelay, w }
  end
end

for i = 1, 3 do
  local k = p .. 'rl:' .. scopes[i] .. ':' .. ids[i] .. ':' .. w
  redis.call('INCR', k)
  redis.call('EXPIRE', k, ttl)
end
redis.call('SET', KEYS[1], slot + minDelay, 'PX', math.max(winMs * 2, 60000))
return { 1, slot, w }
`;

/** Gives a reserved send back to all three counters (e.g. SMTP failed). Never goes below 0. */
const REFUND_LUA = `
local p, sid, cid, w = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local ids = { 'all', sid, cid }
local scopes = { 'g', 's', 'c' }
for i = 1, 3 do
  local k = p .. 'rl:' .. scopes[i] .. ':' .. ids[i] .. ':' .. w
  if tonumber(redis.call('GET', k) or '0') > 0 then redis.call('DECR', k) end
end
return 1
`;

/**
 * Strict spacing at the moment of dispatch. Slots are reserved exactly minDelay apart, but a job
 * that wakes late would squeeze the gap to the next on-time job; this gate measures real dispatch
 * times, so consecutive sends from a sender are never closer than minDelay.
 * Returns 0 if the caller may dispatch now (and records it), else the earliest allowed time.
 */
const GATE_LUA = `
local now, d = tonumber(ARGV[1]), tonumber(ARGV[2])
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
if now < last + d then return last + d end
redis.call('SET', KEYS[1], now, 'PX', math.max(d * 10, 60000))
return 0
`;

export type Scope = 'global' | 'sender' | 'campaign';
const SCOPES: Scope[] = ['global', 'sender', 'campaign'];

export type Limits = { global: number; sender: number; campaign: number };
export type AcquireInput = { now: number; senderId: string; campaignId: string; limits: Limits };

/** A reserved send: at `slot` (epoch ms), counted in window `w`. Stored on the job so it survives restarts. */
export type Ticket = { slot: number; w: number };

export type AcquireResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; scope: Scope; retryAt: number; w: number };

export type RateLimiterOptions = {
  /** Namespaces every key; tests use a random prefix so they never touch live counters. */
  prefix: string;
  windowMs: number;
  minDelayMs: number;
};

type LimiterRedis = Redis & {
  riAcquire(slotKey: string, ...args: (string | number)[]): Promise<[number, number, number, number?]>;
  riRefund(...args: (string | number)[]): Promise<number>;
  riGate(key: string, now: number, minDelay: number): Promise<number>;
};

export class RateLimiter {
  private readonly r: LimiterRedis;
  private readonly ttlSec: number;

  constructor(
    redis: Redis,
    readonly opts: RateLimiterOptions,
  ) {
    if (!('riAcquire' in redis)) {
      redis.defineCommand('riAcquire', { numberOfKeys: 1, lua: ACQUIRE_LUA });
      redis.defineCommand('riRefund', { numberOfKeys: 0, lua: REFUND_LUA });
      redis.defineCommand('riGate', { numberOfKeys: 1, lua: GATE_LUA });
    }
    this.r = redis as LimiterRedis;
    // Counters must outlive their window plus any overflow tail; 3 windows is ample.
    this.ttlSec = Math.ceil((opts.windowMs * 3) / 1000);
  }

  async acquire({ now, senderId, campaignId, limits }: AcquireInput): Promise<AcquireResult> {
    const { prefix, windowMs, minDelayMs } = this.opts;
    const res = await this.r.riAcquire(
      `${prefix}throttle:slot:${senderId}`,
      now,
      windowMs,
      minDelayMs,
      limits.global,
      limits.sender,
      limits.campaign,
      prefix,
      senderId,
      campaignId,
      this.ttlSec,
    );
    if (res[0] === 1) return { ok: true, ticket: { slot: res[1], w: res[2] } };
    return { ok: false, scope: SCOPES[res[1] - 1]!, retryAt: res[2], w: res[3]! };
  }

  async refund(ticket: Ticket, senderId: string, campaignId: string): Promise<void> {
    await this.r.riRefund(this.opts.prefix, senderId, campaignId, ticket.w);
  }

  /** 0 → dispatch now (recorded); otherwise the epoch ms at which this sender may next dispatch. */
  async gate(senderId: string, now: number): Promise<number> {
    if (this.opts.minDelayMs <= 0) return 0;
    return this.r.riGate(`${this.opts.prefix}throttle:last:${senderId}`, now, this.opts.minDelayMs);
  }

  /** Current usage for a sender in the window containing `now` (dashboards/analytics). */
  async senderUsage(senderId: string, now = Date.now()): Promise<number> {
    const w = Math.floor(now / this.opts.windowMs);
    return Number((await this.r.get(`${this.opts.prefix}rl:s:${senderId}:${w}`)) ?? 0);
  }

  /** True only for the first caller per scope+id+window — used to notify Slack exactly once. */
  async firstHitInWindow(scope: Scope, id: string, w: number): Promise<boolean> {
    const key = `${this.opts.prefix}rl:hit:${scope}:${id}:${w}`;
    return (await this.r.set(key, '1', 'EX', this.ttlSec, 'NX')) === 'OK';
  }
}
