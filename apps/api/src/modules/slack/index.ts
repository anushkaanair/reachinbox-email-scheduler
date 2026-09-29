import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { SlackService } from './slackService.js';

/** Shared by the API (OAuth, test message) and the worker (rate-limit notifications). */
export const createSlackService = (http?: typeof fetch) =>
  new SlackService(
    prisma,
    {
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
      redirectUri: env.SLACK_REDIRECT_URI,
      webUrl: env.WEB_URL,
      jwtSecret: env.JWT_SECRET,
    },
    logger,
    http,
  );
