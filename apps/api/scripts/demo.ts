/**
 * Demo helpers for the video (feature F8). Talks to the running API like a real client.
 *
 *   npm run demo -w @ri/api -- load [--count 1000]      1000 emails at once → watch throttling
 *   npm run demo -w @ri/api -- restart                  20 emails over ~1 min → stop & restart the
 *                                                       servers mid-way, then:
 *   npm run demo -w @ri/api -- verify <campaignId>      sent / pending / duplicate check + per-window counts
 *   npm run demo -w @ri/api -- reset --yes              wipe campaigns/emails/queues/counters for a clean
 *                                                       recording (keeps users, senders, Slack connections)
 *
 * DEV ONLY: signs a session for the local dev user (refuses in production).
 */
import { env } from '../src/config/env.js';
import { es } from '../src/lib/elasticsearch.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { setSession } from '../src/modules/auth/session.js';

if (env.isProd) {
  console.error('demo scripts are disabled in production');
  process.exit(1);
}

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flag = (name: string, def: number) => {
  const i = rest.indexOf(`--${name}`);
  return i > -1 ? Number(rest[i + 1]) : def;
};

async function session(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { googleId: 'local-dev-user' },
    create: { googleId: 'local-dev-user', email: 'dev@local.test', name: 'Local Dev' },
    update: {},
  });
  let cookie = '';
  setSession({ cookie: (n: string, v: string) => (cookie = `${n}=${v}`) } as never, user.id);
  return cookie;
}

async function schedule(count: number, startInSec: number, delaySec: number, tag: string) {
  const res = await fetch(`${env.API_URL}/api/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await session() },
    body: JSON.stringify({
      subject: `[${tag}] Hello {{name}}`,
      body: `Hi {{name}},\n\nThis is ${tag} email #{{n}}.`,
      leads: Array.from({ length: count }, (_, i) => ({
        email: `${tag}-${Date.now().toString(36)}-${i}@demo.example`,
        name: `Lead ${i}`,
        vars: { n: String(i + 1) },
      })),
      startAt: new Date(Date.now() + startInSec * 1000).toISOString(),
      delayBetweenSeconds: delaySec,
      hourlyLimit: 10_000,
    }),
  });
  const body = (await res.json()) as { campaignId: string; accepted: number; estimatedFinishAt: string };
  if (!res.ok) throw new Error(`schedule failed: ${JSON.stringify(body)}`);
  return body;
}

async function counts(campaignId: string) {
  const g = await prisma.email.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } });
  const c = Object.fromEntries(g.map((x) => [x.status, x._count._all])) as Record<string, number>;
  return { SCHEDULED: 0, RATE_LIMITED: 0, SENDING: 0, SENT: 0, FAILED: 0, ...c };
}

const pad = (v: unknown, n: number) => String(v).padStart(n);

async function watch(campaignId: string, seconds: number) {
  console.log(`\n${pad('time', 8)} ${pad('scheduled', 10)} ${pad('rate-limited', 13)} ${pad('sending', 8)} ${pad('sent', 6)} ${pad('failed', 7)}`);
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const c = await counts(campaignId);
    console.log(
      `${pad(new Date().toTimeString().slice(0, 8), 8)} ${pad(c.SCHEDULED, 10)} ${pad(c.RATE_LIMITED, 13)} ${pad(c.SENDING, 8)} ${pad(c.SENT, 6)} ${pad(c.FAILED, 7)}`,
    );
    if (c.SCHEDULED + c.RATE_LIMITED + c.SENDING === 0 || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function verify(campaignId: string) {
  const c = await counts(campaignId);
  const [dup] = await prisma.$queryRaw<{ total: bigint; distinct_ids: bigint }[]>`
    SELECT count(*) AS total, count(DISTINCT "messageId") AS distinct_ids
      FROM "Email" WHERE "campaignId" = ${campaignId} AND status = 'SENT'`;
  const perWindow = await prisma.$queryRaw<{ sender: string; window: Date; n: bigint }[]>`
    SELECT s.email AS sender, to_timestamp(floor(extract(epoch FROM e."dispatchedAt") / ${env.RATE_WINDOW_SECONDS}) * ${env.RATE_WINDOW_SECONDS}) AS window, count(*) AS n
      FROM "Email" e JOIN "Sender" s ON s.id = e."senderId"
     WHERE e."campaignId" = ${campaignId} AND e.status = 'SENT'
     GROUP BY 1, 2 ORDER BY 2, 1`;
  const [gap] = await prisma.$queryRaw<{ min_gap_ms: number | null }[]>`
    SELECT min(extract(epoch FROM gap) * 1000)::float AS min_gap_ms FROM (
      SELECT "dispatchedAt" - lag("dispatchedAt") OVER (PARTITION BY "senderId" ORDER BY "dispatchedAt") AS gap
        FROM "Email" WHERE "campaignId" = ${campaignId} AND "dispatchedAt" IS NOT NULL) g`;

  console.log('\nStatus:', c);
  console.log(`Duplicates: ${Number(dup!.total) - Number(dup!.distinct_ids)}  (sent ${dup!.total}, distinct Message-IDs ${dup!.distinct_ids})`);
  console.log(`Min gap between sends of one sender: ${gap?.min_gap_ms == null ? 'n/a' : `${Math.round(gap.min_gap_ms)} ms`} (configured ${env.MIN_DELAY_BETWEEN_EMAILS_MS} ms)`);
  console.log(`Per sender per ${env.RATE_WINDOW_SECONDS}s window (limit ${env.MAX_EMAILS_PER_HOUR_PER_SENDER}):`);
  for (const r of perWindow) console.log(`  ${r.window.toISOString().slice(11, 19)}  ${r.sender.padEnd(34)} ${r.n}`);
}

try {
  if (cmd === 'load') {
    const count = flag('count', 1000);
    const r = await schedule(count, 2, 0, 'load');
    console.log(`Scheduled ${r.accepted} emails all due now (campaign ${r.campaignId}).`);
    console.log(`Limits: ${env.MAX_EMAILS_PER_HOUR_PER_SENDER}/sender & ${env.MAX_EMAILS_PER_HOUR} global per ${env.RATE_WINDOW_SECONDS}s, ≥${env.MIN_DELAY_BETWEEN_EMAILS_MS}ms between sends. ETA ${r.estimatedFinishAt}`);
    await watch(r.campaignId, flag('watch', 90));
    await verify(r.campaignId);
    console.log(`\nNothing was dropped: the rest keep draining in order. Re-check any time:\n  npm run demo -w @ri/api -- verify ${r.campaignId}`);
  } else if (cmd === 'restart') {
    const r = await schedule(20, 5, 3, 'restart');
    console.log(`Scheduled 20 emails, one every 3s starting in 5s (campaign ${r.campaignId}).`);
    console.log('\n  1. Watch a few send in the dashboard.');
    console.log('  2. Stop the servers (Ctrl-C in the `npm run dev` terminal).');
    console.log('  3. Wait ~20s, then start them again (`npm run dev`).');
    console.log(`  4. Verify: npm run demo -w @ri/api -- verify ${r.campaignId}`);
  } else if (cmd === 'reset') {
    if (!rest.includes('--yes')) {
      console.log('This deletes ALL campaigns, emails, queued jobs, rate-limit counters and search docs in the');
      console.log('local database (users, senders and Slack connections are kept). Re-run with --yes to confirm.');
    } else {
      const queues = createQueues(redis);
      for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
      await closeQueues(queues);
      const counters = [...(await redis.keys('rl:*')), ...(await redis.keys('throttle:*')), ...(await redis.keys('reqlimit:*'))];
      if (counters.length) await redis.del(...counters);
      const deleted = await prisma.campaign.deleteMany({}); // cascades to emails + events
      await prisma.rateLimitEvent.deleteMany({});
      await es.deleteByQuery({ index: env.ES_INDEX, query: { match_all: {} }, refresh: true }).catch(() => undefined);
      console.log(`✔ Reset: ${deleted.count} campaigns removed, queues emptied, ${counters.length} counters cleared, search index emptied.`);
    }
  } else if (cmd === 'verify' && rest[0]) {
    await verify(rest[0]);
  } else {
    console.log('usage: npm run demo -w @ri/api -- load [--count N] [--watch S] | restart | verify <campaignId> | reset --yes');
  }
} finally {
  await prisma.$disconnect();
  await redis.quit();
}
