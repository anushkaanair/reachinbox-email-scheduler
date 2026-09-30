import { z } from 'zod';

/**
 * First-run onboarding: a four-question profile, a setup checklist computed from what the user has
 * actually done, and a sending recommendation derived from their monthly volume. Pure and shared so the
 * wizard previews exactly what the API stores.
 */

type Option<T extends string> = { id: T; label: string; hint: string };

export const ROLES = [
  { id: 'founder', label: 'Founder / Small Business', hint: 'Wear every hat, moving fast' },
  { id: 'sales', label: 'Sales or Growth Team', hint: 'Repeatable pipeline at scale' },
  { id: 'agency', label: 'Agency', hint: 'Outreach across multiple clients' },
  { id: 'recruiter', label: 'Recruiter / Hiring Team', hint: 'Sourcing and candidate outreach' },
  { id: 'partnerships', label: 'Partnerships / Affiliates', hint: 'Relationship-led outreach' },
  { id: 'other', label: 'Something Else', hint: 'Tell us more later' },
] as const satisfies readonly Option<string>[];

export const GOALS = [
  { id: 'meetings', label: 'Book meetings', hint: '' },
  { id: 'pipeline', label: 'Generate qualified pipeline', hint: '' },
  { id: 'leads', label: 'Find leads faster', hint: '' },
  { id: 'deals', label: 'Close deals', hint: '' },
  { id: 'recruit', label: 'Recruit candidates', hint: '' },
  { id: 'partnerships', label: 'Build partnerships', hint: '' },
  { id: 'validate', label: 'Validate an offer', hint: '' },
  { id: 'other', label: 'Something else', hint: '' },
] as const satisfies readonly Option<string>[];

export const STAGES = [
  { id: 'new', label: 'Just getting started', hint: 'Brand new to outbound' },
  { id: 'inconsistent', label: 'Running campaigns but inconsistent results', hint: 'Some traction, needs tuning' },
  { id: 'scaling', label: 'Outbound working & want to scale', hint: 'Ready to grow safely' },
  { id: 'teams', label: 'Managing outreach across clients or teams', hint: 'Multiple workspaces' },
] as const satisfies readonly Option<string>[];

export const VOLUMES = [
  { id: 'starter', label: 'Just getting started', hint: 'Up to 2,000 active leads/month', leads: 2_000 },
  { id: 'growing', label: 'Growing outbound motion', hint: 'Around 2,000–50,000 active leads/month', leads: 25_000 },
  { id: 'scaling', label: 'Scaling aggressively', hint: 'Around 50,000–200,000 active leads/month', leads: 125_000 },
  { id: 'enterprise', label: 'Enterprise-scale outreach', hint: '200,000+ active leads/month', leads: 300_000 },
] as const satisfies readonly (Option<string> & { leads: number })[];

const ids = <T extends readonly { id: string }[]>(list: T) => list.map((o) => o.id) as [T[number]['id'], ...T[number]['id'][]];

export const OnboardingProfileSchema = z.object({
  role: z.enum(ids(ROLES)),
  goal: z.enum(ids(GOALS)),
  stage: z.enum(ids(STAGES)),
  volume: z.enum(ids(VOLUMES)),
});
export type OnboardingProfile = z.infer<typeof OnboardingProfileSchema>;

/** What we store per user (null = hasn't seen onboarding yet). */
export const OnboardingStateSchema = z.object({
  status: z.enum(['completed', 'skipped']),
  profile: OnboardingProfileSchema.nullable(),
  tour: z.enum(['pending', 'done', 'skipped']),
  checklistDismissed: z.boolean(),
  updatedAt: z.string(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete'), profile: OnboardingProfileSchema }),
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('tour'), status: z.enum(['pending', 'done', 'skipped']) }),
  z.object({ action: z.literal('dismiss_checklist'), dismissed: z.boolean() }),
]);
export type OnboardingUpdate = z.infer<typeof OnboardingUpdateSchema>;

// ── checklist ────────────────────────────────────────────────────────────────

/** Facts about the account that the checklist is computed from. */
export type SetupFacts = {
  activeSenders: number;
  warmingSenders: number;
  campaigns: number;
  sentEmails: number;
  slackConnected: boolean;
};

export const ChecklistStepSchema = z.object({
  id: z.enum(['connect', 'warmup', 'campaign', 'send', 'slack']),
  title: z.string(),
  description: z.string(),
  done: z.boolean(),
  href: z.string(),
  cta: z.string(),
  /** Steps marked optional don't count against "setup complete". */
  optional: z.boolean(),
});
export type ChecklistStep = z.infer<typeof ChecklistStepSchema>;

export function buildChecklist(f: SetupFacts): ChecklistStep[] {
  return [
    { id: 'connect', title: 'Connect email accounts', description: 'Add the mailboxes you’ll send from. We check each login before saving.', done: f.activeSenders > 0, href: '/senders', cta: 'Connect accounts', optional: false },
    { id: 'warmup', title: 'Warm up an account', description: 'Start new mailboxes slowly: a few emails on day 1, a few more each day.', done: f.warmingSenders > 0, href: '/senders', cta: 'Set up warm-up', optional: true },
    { id: 'campaign', title: 'Schedule your first campaign', description: 'Upload leads, write the email, choose the start time, delay and hourly limit.', done: f.campaigns > 0, href: '/compose', cta: 'Compose an email', optional: false },
    { id: 'send', title: 'Get your first email out', description: 'Watch it move from Scheduled to Sent, with a link to open it in the inbox.', done: f.sentEmails > 0, href: '/dashboard/sent', cta: 'See sent emails', optional: false },
    { id: 'slack', title: 'Get Slack alerts', description: 'Be told the moment a sender hits its limit.', done: f.slackConnected, href: '/settings', cta: 'Connect Slack', optional: true },
  ];
}

export function checklistProgress(steps: ChecklistStep[]): { done: number; total: number; percent: number; complete: boolean } {
  const done = steps.filter((s) => s.done).length;
  const required = steps.filter((s) => !s.optional);
  return { done, total: steps.length, percent: Math.round((done / steps.length) * 100), complete: required.every((s) => s.done) };
}

// ── recommendation ───────────────────────────────────────────────────────────

export const OnboardingStatusSchema = z.object({
  state: OnboardingStateSchema.nullable(),
  checklist: z.array(ChecklistStepSchema),
  progress: z.object({ done: z.number(), total: z.number(), percent: z.number(), complete: z.boolean() }),
});
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;

export type Recommendation = {
  headline: string;
  accounts: number;
  dailyPerAccount: number;
  monthlyCapacity: number;
  warmupWeeks: number;
  tips: string[];
};

/** Conservative per-mailbox volume: ~40 emails a day, weekdays only (≈ 880 a month). */
const DAILY_PER_ACCOUNT = 40;
const SENDING_DAYS_PER_MONTH = 22;
/** A typical sequence sends each lead this many emails (first email + follow-ups). */
const EMAILS_PER_LEAD = 3;

export function recommendSetup(p: OnboardingProfile): Recommendation {
  const leads = VOLUMES.find((v) => v.id === p.volume)!.leads;
  const perAccountMonthly = DAILY_PER_ACCOUNT * SENDING_DAYS_PER_MONTH;
  const accounts = Math.max(1, Math.ceil((leads * EMAILS_PER_LEAD) / perAccountMonthly));
  const newToOutbound = p.stage === 'new';
  const role = ROLES.find((r) => r.id === p.role)!.label;
  const tips = [
    newToOutbound ? 'Warm every new mailbox for about two weeks before sending at full volume.' : 'Keep warm-up on, even while campaigns run.',
    `Keep each mailbox near ${DAILY_PER_ACCOUNT} emails a day; add mailboxes rather than raising the limit.`,
  ];
  if (accounts > 5) tips.push('At this scale, spread sending across several domains and watch bounce rates closely.');
  if (p.stage === 'inconsistent') tips.push('Check each account’s health and DNS (SPF, DKIM, DMARC) before changing your copy.');
  if (p.stage === 'teams') tips.push('Tag accounts by client or team so they’re easy to filter and bulk-edit.');
  return {
    headline: `${newToOutbound ? 'Getting started with outbound' : 'Scaling outbound'} as ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}`,
    accounts,
    dailyPerAccount: DAILY_PER_ACCOUNT,
    monthlyCapacity: accounts * perAccountMonthly,
    warmupWeeks: newToOutbound ? 2 : 1,
    tips,
  };
}

