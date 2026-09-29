import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { authedUserId, requireAuth } from '../auth/session.js';
import type { SlackService } from './slackService.js';

export function slackRouter(slack: SlackService, webUrl: string) {
  const router = Router();
  const back = (result: string) => `${webUrl}/settings?slack=${encodeURIComponent(result)}`;

  // OAuth callback is public: it arrives through the HTTPS tunnel (no localhost cookie there);
  // the signed `state` carries and authenticates the user instead.
  router.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return res.redirect(back(error === 'access_denied' ? 'denied' : 'error'));
    const userId = state ? slack.verifyState(state) : null;
    if (!userId || !code) return res.redirect(back('invalid_state'));
    try {
      await slack.completeOAuth(userId, code);
      res.redirect(back('connected'));
    } catch (err) {
      logger.warn({ err }, 'slack oauth callback failed');
      res.redirect(back('error'));
    }
  });

  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      res.json(await slack.status(authedUserId(req)));
    } catch (err) {
      next(err);
    }
  });

  // Full-page navigation from the "Connect Slack" button.
  router.get('/connect', (req, res) => {
    if (!slack.configured) return res.redirect(back('not_configured'));
    res.redirect(slack.authorizeUrl(authedUserId(req)));
  });

  router.post('/test', async (req, res, next) => {
    try {
      const result = await slack.sendTest(authedUserId(req));
      if (result === 'skipped_not_connected') throw new AppError(409, 'CONFLICT', 'Slack is not connected');
      if (result === 'skipped_invalid') throw new AppError(409, 'CONFLICT', 'Slack rejected the webhook — please reconnect');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete('/', async (req, res, next) => {
    try {
      await slack.disconnect(authedUserId(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
