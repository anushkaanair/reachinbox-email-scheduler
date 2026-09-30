import type { PrismaClient } from '@prisma/client';
import type { PreflightInput, PreflightResponse } from '@ri/shared';
import type { RateLimiter } from '../../throttle/rateLimiter.js';
import { applyGuards, scheduleTimes } from './planning.js';
import { computeForecast, loadSenders, normalizeLeads, type SchedulingConfig } from './service.js';

/**
 * Compose-time report: how many leads are valid, who is skipped (do-not-contact / recently emailed)
 * and a window-by-window forecast of when the rest will go out. Read-only — nothing is scheduled.
 */
export async function preflight(
  userId: string,
  input: PreflightInput,
  deps: { prisma: PrismaClient; config: SchedulingConfig; limiter?: RateLimiter },
): Promise<PreflightResponse> {
  const normalized = normalizeLeads(input.emails.map((email) => ({ email })));
  const guarded = await applyGuards(deps.prisma, userId, normalized.clean, input.skipRecentDays);
  const senders = await loadSenders(deps.prisma, input.senderIds);

  const startMs = Math.max(Date.now(), new Date(input.startAt).getTime());
  const times = scheduleTimes(guarded.sendable.length, startMs, input.delayBetweenSeconds * 1000, input.sendWindow);
  const fc =
    senders.length === 0
      ? { firstSendAt: null, finishAt: null, windows: [], windowsTotal: 0, truncated: false }
      : await computeForecast({
          times,
          senders,
          campaignLimit: input.hourlyLimit,
          sendWindow: input.sendWindow,
          config: deps.config,
          limiter: deps.limiter,
        });

  return {
    valid: normalized.clean.length,
    invalid: normalized.invalid.length,
    duplicates: normalized.duplicates,
    suppressed: guarded.suppressed.length,
    recentlyEmailed: guarded.recentlyEmailed.length,
    sendable: guarded.sendable.length,
    windowSeconds: deps.config.windowMs / 1000,
    forecast: fc,
  };
}
