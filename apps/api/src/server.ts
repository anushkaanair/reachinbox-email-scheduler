import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { onShutdown } from './lib/shutdown.js';
import { closeQueues } from './queues/queues.js';

const app = createApp();
// Search is not on the critical path: if ES is down the API still serves everything else.
app.search.ensureIndex().catch((err) => logger.warn({ err: err.message }, 'elasticsearch index check failed'));
const server = app.listen(env.API_PORT, () => {
  logger.info(`API listening on ${env.API_URL} (web: ${env.WEB_URL}, queues: ${env.API_URL}/admin/queues)`);
});

onShutdown([
  { name: 'live streams', close: () => app.live.close() },
  { name: 'http', close: () => new Promise((r) => server.close(r)) },
  { name: 'queues', close: () => closeQueues(app.queues) },
  { name: 'prisma', close: () => prisma.$disconnect() },
  { name: 'redis', close: () => redis.quit() },
]);
