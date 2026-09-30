import { z } from 'zod';

/**
 * Bounce protection: a campaign that keeps hitting addresses that don't exist damages every sender's
 * reputation, so it pauses itself. The check runs when a bounce happens (no timer, no cron), and waits
 * for a minimum sample so a single early bounce can't stop a small campaign.
 */

export const BounceProtectionSchema = z.object({
  /** Pause when hard bounces exceed this % of attempted emails. 0 turns protection off. */
  thresholdPercent: z.coerce.number().int().min(0).max(100).default(10),
  /** Don't judge until at least this many emails have been attempted. */
  minSends: z.coerce.number().int().min(1).max(10_000).default(20),
});
export type BounceProtection = z.infer<typeof BounceProtectionSchema>;

export const DEFAULT_BOUNCE_PROTECTION: BounceProtection = { thresholdPercent: 10, minSends: 20 };

export type BounceVerdict = {
  /** Emails that reached a verdict: delivered plus hard-bounced. */
  attempts: number;
  /** Bounce rate as a percentage, or null when nothing was attempted. */
  ratePercent: number | null;
  /** True when protection is on, the sample is big enough, and the rate is over the threshold. */
  breached: boolean;
};

export function bounceVerdict(counts: { sent: number; bounced: number }, p: BounceProtection): BounceVerdict {
  const attempts = counts.sent + counts.bounced;
  if (attempts === 0) return { attempts, ratePercent: null, breached: false };
  const ratePercent = (counts.bounced / attempts) * 100;
  return { attempts, ratePercent, breached: p.thresholdPercent > 0 && attempts >= p.minSends && ratePercent > p.thresholdPercent };
}

/** Why a campaign is paused when a person didn't do it. */
export const CampaignPauseReasonSchema = z.enum(['BOUNCE_PROTECTION']);
export type CampaignPauseReason = z.infer<typeof CampaignPauseReasonSchema>;
