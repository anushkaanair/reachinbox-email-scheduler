import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { QueueSet } from './queues.js';

export const BULL_BOARD_PATH = '/admin/queues';

/** Live queue dashboard (required by the brief). Mounted behind requireAuth in app.ts. */
export function bullBoardRouter(queues: QueueSet) {
  const adapter = new ExpressAdapter();
  adapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(queues.email), new BullMQAdapter(queues.notify), new BullMQAdapter(queues.index)],
    serverAdapter: adapter,
    options: { uiConfig: { boardTitle: 'ReachInbox Queues' } },
  });
  return adapter.getRouter();
}
