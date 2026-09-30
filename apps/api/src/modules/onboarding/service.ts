import type { Prisma, PrismaClient } from '@prisma/client';
import {
  buildChecklist,
  checklistProgress,
  OnboardingStateSchema,
  type OnboardingState,
  type OnboardingStatus,
  type OnboardingUpdate,
} from '@ri/shared';

/** What the account has actually done — the checklist is derived from this, never ticked by hand. */
export async function setupFacts(prisma: PrismaClient, userId: string) {
  const [activeSenders, warmingSenders, campaigns, sentEmails, slack] = await Promise.all([
    prisma.sender.count({ where: { isActive: true } }),
    prisma.sender.count({ where: { isActive: true, warmupEnabled: true } }),
    prisma.campaign.count({ where: { userId } }),
    prisma.email.count({ where: { userId, status: 'SENT' } }),
    prisma.slackConnection.findUnique({ where: { userId }, select: { isValid: true } }),
  ]);
  return { activeSenders, warmingSenders, campaigns, sentEmails, slackConnected: slack?.isValid === true };
}

const readState = (raw: Prisma.JsonValue | null): OnboardingState | null => OnboardingStateSchema.safeParse(raw).data ?? null;

export async function onboardingStatus(prisma: PrismaClient, userId: string): Promise<OnboardingStatus> {
  const [user, facts] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { onboarding: true } }), setupFacts(prisma, userId)]);
  const checklist = buildChecklist(facts);
  return { state: readState(user?.onboarding ?? null), checklist, progress: checklistProgress(checklist) };
}

/** Apply one change. `complete`/`skip` (re)start the tour as pending only the first time. */
export async function updateOnboarding(prisma: PrismaClient, userId: string, input: OnboardingUpdate): Promise<OnboardingStatus> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboarding: true } });
  const prev = readState(user.onboarding);
  const base: OnboardingState = prev ?? { status: 'skipped', profile: null, tour: 'pending', checklistDismissed: false, updatedAt: '' };
  const next: OnboardingState = { ...base, updatedAt: new Date().toISOString() };

  switch (input.action) {
    case 'complete':
      next.status = 'completed';
      next.profile = input.profile;
      break;
    case 'skip':
      // Skipping must never throw away answers the user already gave.
      next.status = prev?.status ?? 'skipped';
      break;
    case 'tour':
      next.tour = input.status;
      break;
    case 'dismiss_checklist':
      next.checklistDismissed = input.dismissed;
      break;
  }
  await prisma.user.update({ where: { id: userId }, data: { onboarding: next as unknown as Prisma.InputJsonValue } });
  return onboardingStatus(prisma, userId);
}
