import { logger } from './logger.js';

type Closer = { name: string; close: () => Promise<unknown> };

/**
 * Graceful shutdown: close resources in order (e.g. stop taking jobs → finish in-flight → close
 * connections) so a restart never leaves an email half-processed.
 */
export function onShutdown(closers: Closer[], timeoutMs = 20_000): void {
  let shuttingDown = false;
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down gracefully');
    const force = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    force.unref();
    for (const c of closers) {
      try {
        await c.close();
        logger.info(`closed ${c.name}`);
      } catch (err) {
        logger.error({ err }, `failed closing ${c.name}`);
      }
    }
    // pino writes asynchronously (worker-thread transport); flush before exiting or logs are lost.
    await new Promise<void>((resolve) => logger.flush(() => resolve()));
    process.exit(0);
  };
  process.on('SIGINT', () => void handler('SIGINT'));
  process.on('SIGTERM', () => void handler('SIGTERM'));
}
