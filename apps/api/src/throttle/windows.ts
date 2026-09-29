/**
 * Fixed rate-limit windows, aligned to the epoch (UTC). With the default 3600 s these are
 * exactly clock hours; shorter windows (e.g. 120 s) make the rollover demoable.
 */
export const windowIndex = (nowMs: number, windowMs: number) => Math.floor(nowMs / windowMs);
export const windowStart = (index: number, windowMs: number) => index * windowMs;
export const windowEnd = (index: number, windowMs: number) => (index + 1) * windowMs;
