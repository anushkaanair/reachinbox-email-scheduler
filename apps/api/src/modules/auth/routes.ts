import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import passport from 'passport';
import type { User } from '@ri/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import type { AuthedUser } from './google.js';
import {
  OAUTH_STATE_COOKIE,
  authedUserId,
  clearSession,
  cookieBase,
  requireAuth,
  setSession,
} from './session.js';

export const authRouter = Router();

const loginError = (reason: string) => `${env.WEB_URL}/login?error=${encodeURIComponent(reason)}`;

const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Step 1: redirect to Google. A random `state` is bound to this browser via cookie (CSRF defence).
authRouter.get('/google', (req, res, next) => {
  // Browser navigation, not XHR — bounce back to the login page with a readable reason.
  if (!env.googleConfigured) return res.redirect(loginError('not_configured'));
  const state = randomBytes(24).toString('base64url');
  res.cookie(OAUTH_STATE_COOKIE, state, { ...cookieBase, maxAge: 10 * 60 * 1000 });
  passport.authenticate('google', {
    scope: ['openid', 'email', 'profile'],
    session: false,
    state,
    prompt: 'select_account',
  })(req, res, next);
});

// Step 2: Google redirects back → verify state → upsert user → session cookie → dashboard.
authRouter.get('/google/callback', (req, res, next) => {
  if (!env.googleConfigured) return res.redirect(loginError('not_configured'));
  const expected = req.cookies?.[OAUTH_STATE_COOKIE];
  const got = typeof req.query.state === 'string' ? req.query.state : '';
  res.clearCookie(OAUTH_STATE_COOKIE, cookieBase);
  if (!expected || !safeEqual(expected, got)) return res.redirect(loginError('state_mismatch'));

  passport.authenticate('google', { session: false }, (err: unknown, user: AuthedUser | false) => {
    if (err || !user) {
      logger.warn({ err }, 'google oauth failed');
      return res.redirect(loginError('oauth_failed'));
    }
    setSession(res, user.id);
    res.redirect(`${env.WEB_URL}/dashboard`);
  })(req, res, next);
});

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: authedUserId(req) },
      include: { slack: { select: { isValid: true } } },
    });
    if (!user) {
      clearSession(res);
      throw AppError.unauthenticated('Account no longer exists');
    }
    const body: User = {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      slackConnected: Boolean(user.slack?.isValid),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});
