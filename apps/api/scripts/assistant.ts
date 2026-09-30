/**
 * Try "Ask Inbox" (offline mode) from the terminal — no UI needed.
 *
 *   npm run assistant -w @ri/api -- "how many emails failed today?"     one question
 *   npm run assistant -w @ri/api                                        interactive chat
 *
 * Changes are proposed first; you'll be asked to confirm (y/N). DEV ONLY (uses the local dev user).
 */
import { createInterface } from 'node:readline/promises';
import type { AssistantBlock, AssistantContext, AssistantReply } from '@ri/shared';
import { env } from '../src/config/env.js';
import { es } from '../src/lib/elasticsearch.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { confirmAction, declineAction, handleMessage, type AssistantDeps } from '../src/modules/assistant/engine.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';

if (env.isProd) {
  console.error('This script is disabled in production.');
  process.exit(1);
}

const user = await prisma.user.upsert({
  where: { googleId: 'local-dev-user' },
  create: { googleId: 'local-dev-user', email: 'dev@local.test', name: 'Local Dev' },
  update: {},
});
const queues = createQueues(redis);
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
const deps: AssistantDeps = {
  prisma,
  redis,
  queues,
  limiter: new RateLimiter(redis, { prefix: '', windowMs: env.RATE_WINDOW_SECONDS * 1000, minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS }),
  config: { perSenderDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER },
  health: async () => ({ db: true, redis: await ok(redis.ping()), elasticsearch: await ok(es.ping()) }),
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function renderBlock(b: AssistantBlock): string {
  switch (b.type) {
    case 'stats':
      return '  ' + b.items.map((i) => `${bold(i.value)} ${dim(i.label)}`).join('   ');
    case 'table': {
      const widths = b.columns.map((c, i) => Math.max(c.length, ...b.rows.map((r) => (r[i] ?? '').length)));
      const line = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
      return [dim(line(b.columns)), ...b.rows.map(line)].join('\n');
    }
    case 'list':
      return b.items.map((i) => `  • ${i.title}${i.subtitle ? dim(`  — ${i.subtitle}`) : ''}`).join('\n');
    case 'timeline':
      return b.items.map((i) => `  ${dim(new Date(i.at).toLocaleString())}  ${i.label}${i.detail ? dim(` (${i.detail})`) : ''}`).join('\n');
    case 'bars': {
      const w = 24;
      return b.items.map((i) => `  ${i.label.padEnd(34)} ${'█'.repeat(Math.round((i.value / Math.max(1, i.max)) * w)).padEnd(w, '░')} ${i.hint ?? ''}`).join('\n');
    }
  }
}

function print(r: AssistantReply) {
  console.log(`\n${r.text}`);
  for (const b of r.blocks) console.log(renderBlock(b));
  if (r.navigate) console.log(dim(`  → would open ${r.navigate.label} (${r.navigate.to})`));
  if (r.download) console.log(dim(`  ↓ ${r.download.label}: ${r.download.url}`));
  if (r.suggestions.length) console.log(dim(`\n  try: ${r.suggestions.map((s) => `“${s}”`).join('  ')}`));
}

let context: AssistantContext | undefined;
async function turn(message: string, rl?: ReturnType<typeof createInterface>) {
  const reply = await handleMessage(user.id, { message, context, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, deps);
  context = reply.context ?? context;
  print(reply);
  if (reply.pending) {
    console.log(`\n  ${reply.pending.danger ? '\x1b[31m⚠ ' : ''}${bold(reply.pending.title)}\x1b[0m`);
    const yes = rl ? (await rl.question(`  Confirm "${reply.pending.confirmLabel}"? (y/N) `)).trim().toLowerCase() === 'y' : false;
    if (!rl) console.log(dim('  (not confirmed — run interactively to confirm)'));
    const done = yes ? await confirmAction(user.id, reply.pending.id, deps) : await declineAction(user.id, reply.pending.id, deps);
    print(done);
    context = done.context ?? context;
  }
}

const arg = process.argv.slice(2).join(' ').trim();
if (arg) {
  await turn(arg);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(bold('Ask Inbox') + dim(' (offline mode) — type “help”, or “exit” to quit'));
  for (;;) {
    const line = (await rl.question('\n› ').catch(() => 'exit')).trim();
    if (!line) continue;
    if (/^(exit|quit|q)$/i.test(line)) break;
    await turn(line, rl);
  }
  rl.close();
}

await closeQueues(queues);
await prisma.$disconnect();
await redis.quit();
process.exit(0);
