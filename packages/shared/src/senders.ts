import { z } from 'zod';
import { DnsReportSchema, SenderProviderSchema } from './accounts.js';

/**
 * Sender health and warm-up. A new mailbox should start slowly and send a little more each day
 * ("warm-up ramp"); a mailbox that keeps failing should stop and cool down instead of burning its
 * reputation. The maths lives here (pure) so the API, the worker and the UI agree.
 */

export const WarmupSettingsSchema = z
  .object({
    /** Emails allowed on day 1. */
    start: z.coerce.number().int().min(1).max(500),
    /** Added each day. */
    increment: z.coerce.number().int().min(1).max(500),
    /** Daily volume at which warm-up is complete and the daily cap lifts. */
    target: z.coerce.number().int().min(1).max(10_000),
  })
  .refine((w) => w.target >= w.start, { message: 'Target must be at least the day-1 volume', path: ['target'] });
export type WarmupSettings = z.infer<typeof WarmupSettingsSchema>;

export const DEFAULT_WARMUP: WarmupSettings = { start: 5, increment: 5, target: 50 };

/** Which warm-up day `now` falls on (1-based), counting whole "days" of length `dayMs` since the start. */
export function warmupDay(startedAt: number, now: number, dayMs: number): number {
  return Math.max(1, Math.floor(now / dayMs) - Math.floor(startedAt / dayMs) + 1);
}

/** Daily cap on a given day, or null once the ramp has reached its target (warm-up complete). */
export function warmupCap(w: WarmupSettings, day: number): number | null {
  const cap = w.start + w.increment * (day - 1);
  return cap >= w.target ? null : cap;
}

/** The whole ramp, day by day, ending with the day the target is reached. */
export function warmupPlan(w: WarmupSettings): { day: number; cap: number }[] {
  const out: { day: number; cap: number }[] = [];
  for (let day = 1; day <= 120; day++) {
    const cap = Math.min(w.target, w.start + w.increment * (day - 1));
    out.push({ day, cap });
    if (cap >= w.target) break;
  }
  return out;
}

// ── health ───────────────────────────────────────────────────────────────────

export type SenderStats = {
  sent: number;
  failed: number;
  /** Times its emails were pushed to a later window by a limit. */
  deferred: number;
  /** Permanent recipient rejections (SMTP 5xx: unknown mailbox, rejected). */
  hardBounces: number;
  consecutiveFailures: number;
  paused: boolean;
  authError: boolean;
};

export type HealthStatus = 'healthy' | 'watch' | 'at_risk' | 'paused';
export type HealthReport = { score: number; status: HealthStatus; reasons: string[] };

const pct = (n: number) => `${Math.round(n * 100)}%`;

/**
 * 0–100 score from recent activity. Heuristic and explainable: every deduction comes with a reason
 * the UI shows. Few sends → little evidence → the score stays close to neutral-good.
 */
export function senderHealth(s: SenderStats): HealthReport {
  const reasons: string[] = [];
  let score = 100;
  const attempts = s.sent + s.failed;

  if (s.authError) {
    score -= 60;
    reasons.push('The SMTP server rejected its login — check the account password.');
  }
  if (attempts > 0) {
    const failRate = s.failed / attempts;
    const bounceRate = s.hardBounces / attempts;
    // Weight by evidence: 3 failures out of 4 means more than 1 out of 1.
    const confidence = Math.min(1, attempts / 20);
    if (failRate > 0.02) {
      score -= Math.round(Math.min(45, failRate * 150) * confidence);
      reasons.push(`${pct(failRate)} of recent sends failed.`);
    }
    if (bounceRate > 0.02) {
      score -= Math.round(Math.min(30, bounceRate * 300) * confidence);
      reasons.push(`${pct(bounceRate)} bounced (recipient rejected) — clean your lead lists.`);
    }
  }
  if (s.consecutiveFailures >= 2) {
    score -= Math.min(25, s.consecutiveFailures * 5);
    reasons.push(`The last ${s.consecutiveFailures} sends in a row failed.`);
  }
  if (s.deferred > Math.max(10, s.sent)) {
    score -= 5;
    reasons.push('Often hits its sending limit — consider more senders or a lower pace.');
  }
  score = Math.max(0, Math.min(100, score));
  const status: HealthStatus = s.paused ? 'paused' : score >= 80 ? 'healthy' : score >= 55 ? 'watch' : 'at_risk';
  if (reasons.length === 0) reasons.push(attempts === 0 ? 'No recent sends yet.' : 'Sending normally.');
  return { score, status, reasons };
}

/** SMTP errors that mean "this account can't log in" — pause the sender straight away. */
export const isAuthError = (message: string) => /\b535\b|\b534\b|EAUTH|invalid login|authentication (failed|unsuccessful)|username and password not accepted/i.test(message);
/** SMTP errors that mean "this recipient will never accept it" (hard bounce). */
export const isHardBounce = (message: string) => /\b55[0-4]\b|\b5\.1\.[0-9]\b|user unknown|no such user|mailbox (unavailable|not found)|recipient rejected/i.test(message);

// ── API shapes ───────────────────────────────────────────────────────────────

export const SenderDetailSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  hourlyLimit: z.number(),
  usedThisWindow: z.number(),
  sentToday: z.number(),
  health: z.object({
    score: z.number(),
    status: z.enum(['healthy', 'watch', 'at_risk', 'paused']),
    reasons: z.array(z.string()),
  }),
  stats: z.object({ sent: z.number(), failed: z.number(), deferred: z.number(), hardBounces: z.number() }),
  provider: SenderProviderSchema,
  firstName: z.string(),
  lastName: z.string(),
  /** Campaign emails per day (null = no daily limit). */
  dailyLimit: z.number().nullable(),
  /** Per-account override of the hourly limit, or null when the server default applies. */
  hourlyLimitOverride: z.number().nullable(),
  minDelaySeconds: z.number().nullable(),
  signature: z.string().nullable(),
  replyTo: z.string().nullable(),
  tags: z.array(z.string()),
  /** Hard bounces recorded today (UTC). */
  bouncedToday: z.number(),
  /** Number of campaigns this account has sent for. */
  campaignCount: z.number(),
  dns: DnsReportSchema.nullable(),
  lastTest: z.object({ at: z.string(), ok: z.boolean() }).nullable(),
  /** What needs the owner's attention: a login/connection error or an automatic pause. */
  attention: z.enum(['error', 'paused']).nullable(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  pausedUntil: z.string().nullable(),
  pauseReason: z.string().nullable(),
  warmup: z.object({
    enabled: z.boolean(),
    settings: WarmupSettingsSchema,
    startedAt: z.string().nullable(),
    /** 1-based; null when warm-up is off. */
    day: z.number().nullable(),
    /** Today's cap; null when off or complete. */
    capToday: z.number().nullable(),
    complete: z.boolean(),
    plan: z.array(z.object({ day: z.number(), cap: z.number() })),
  }),
  /** Seconds in one warm-up "day" (86400 normally; shorter in demo mode). */
  dayLengthSeconds: z.number(),
  healthWindowDays: z.number(),
});
export type SenderDetail = z.infer<typeof SenderDetailSchema>;

export const WarmupUpdateSchema = z.object({
  enabled: z.boolean(),
  settings: WarmupSettingsSchema.optional(),
  /** Start the ramp again from day 1. */
  restart: z.boolean().optional(),
});
export type WarmupUpdate = z.infer<typeof WarmupUpdateSchema>;
