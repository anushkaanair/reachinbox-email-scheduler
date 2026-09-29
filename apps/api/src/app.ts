import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import passport from 'passport';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { es } from './lib/elasticsearch.js';
import { prisma } from './lib/prisma.js';
import { createRedis, redis } from './lib/redis.js';
import { analyticsRouter } from './modules/analytics/routes.js';
import { LiveHub } from './modules/events/hub.js';
import { RateLimiter } from './throttle/rateLimiter.js';
import { configureGoogle } from './modules/auth/google.js';
import { authRouter } from './modules/auth/routes.js';
import { requireAdmin, requireAuth } from './modules/auth/session.js';
import { redactUrl, requestLimit } from './lib/httpSecurity.js';
import { campaignsRouter } from './modules/campaigns/routes.js';
import { emailsRouter } from './modules/emails/routes.js';
import { EmailSearch } from './modules/search/emailSearch.js';
import { createSlackService } from './modules/slack/index.js';
import { slackRouter } from './modules/slack/routes.js';
import type { SlackService } from './modules/slack/slackService.js';
import { healthRouter } from './modules/health/routes.js';
import { sendersRouter } from './modules/senders/routes.js';
import { BULL_BOARD_PATH, bullBoardRouter } from './queues/bullboard.js';
import { createQueues, type QueueSet } from './queues/queues.js';

/**
 * Builds the Express app without listening, so tests can mount it with supertest.
 * `queues` is injectable so tests can isolate from a running dev worker.
 */
export function createApp(opts: { queues?: QueueSet; search?: EmailSearch; slack?: SlackService } = {}) {
  const live = new LiveHub(() => createRedis('live-sub'));
  const limiter = new RateLimiter(redis, { prefix: '', windowMs: env.RATE_WINDOW_SECONDS * 1000, minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS });
  const queues = opts.queues ?? createQueues(redis);
  const search = opts.search ?? new EmailSearch(es, prisma, env.ES_INDEX);
  const slack = opts.slack ?? createSlackService();
  configureGoogle();

  const app = express();
  app.set('trust proxy', 1);
  // Bull Board serves inline scripts, so CSP is relaxed (the API serves no other HTML).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.WEB_URL, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url?.startsWith(BULL_BOARD_PATH) === true },
      // Never log OAuth codes/state or cookies (S1).
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: redactUrl(req.url) }),
      },
    }),
  );
  app.use(passport.initialize());

  app.use('/healthz', healthRouter);
  app.use('/api/health', healthRouter);
  // Abuse throttling (S4): login attempts per IP, campaign creation per user.
  app.use('/api/auth/google', requestLimit(redis, { name: 'login', limit: 30, windowSec: 60, key: (req) => req.ip ?? 'ip' }));
  app.post(
    '/api/campaigns',
    requireAuth,
    requestLimit(redis, { name: 'campaigns', limit: 20, windowSec: 60, key: (req) => req.userId ?? 'anon' }),
  );
  app.use('/api/auth', authRouter);
  app.use('/api/campaigns', campaignsRouter(queues));
  app.use('/api/emails', emailsRouter(search, { prisma, queues, redis }));
  app.get('/api/events', requireAuth, live.handler);
  app.use(
    '/api/analytics',
    analyticsRouter({ prisma, limiter, perSenderDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER, windowSeconds: env.RATE_WINDOW_SECONDS }),
  );
  app.use('/api/slack', slackRouter(slack, env.WEB_URL));
  app.use('/api/senders', sendersRouter);
  app.use(BULL_BOARD_PATH, requireAuth, requireAdmin, bullBoardRouter(queues));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return Object.assign(app, { queues, search, live });
}
