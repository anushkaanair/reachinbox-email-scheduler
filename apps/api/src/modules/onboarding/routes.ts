import { Router } from 'express';
import { OnboardingUpdateSchema } from '@ri/shared';
import { prisma } from '../../lib/prisma.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import { onboardingStatus, updateOnboarding } from './service.js';

export const onboardingRouter = Router();
onboardingRouter.use(requireAuth);

// GET /api/onboarding — the user's answers and tour state plus the live setup checklist.
onboardingRouter.get('/', async (req, res, next) => {
  try {
    res.json(await onboardingStatus(prisma, authedUserId(req)));
  } catch (err) {
    next(err);
  }
});

// PUT /api/onboarding { action: 'complete' | 'skip' | 'tour' | 'dismiss_checklist', … }
onboardingRouter.put('/', async (req, res, next) => {
  try {
    res.json(await updateOnboarding(prisma, authedUserId(req), OnboardingUpdateSchema.parse(req.body)));
  } catch (err) {
    next(err);
  }
});
