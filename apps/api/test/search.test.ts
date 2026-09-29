import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HL_CLOSE, HL_OPEN } from '@ri/shared';
import { createApp } from '../src/app.js';
import { es } from '../src/lib/elasticsearch.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { EmailSearch } from '../src/modules/search/emailSearch.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeSender, makeUser, testPrefix } from './helpers.js';

const search = new EmailSearch(es, prisma, `test-emails-${testPrefix()}`);
const conn = createRedis('test-search');
const queues = createQueues(conn, testPrefix());
const app = createApp({ queues, search });

let alice: string;
let bob: string;
let senderId: string;
const ids: Record<string, string> = {};

const cookie = (userId: string) => {
  let h = '';
  setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
  return h;
};

async function seed(userId: string, key: string, toEmail: string, subject: string, body: string, status: 'SCHEDULED' | 'SENT' = 'SCHEDULED') {
  const campaign = await prisma.campaign.create({
    data: { userId, subject, body, startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, totalRecipients: 1 },
  });
  const e = await prisma.email.create({
    data: {
      id: randomUUID(), campaignId: campaign.id, userId, senderId, toEmail, subject, body, sequence: 0,
      scheduledAt: new Date(), nextAttemptAt: new Date(), status, ...(status === 'SENT' ? { sentAt: new Date() } : {}),
    },
  });
  ids[key] = e.id;
}

beforeAll(async () => {
  await search.ensureIndex();
  alice = (await makeUser('alice')).id;
  bob = (await makeUser('bob')).id;
  senderId = (await makeSender()).id;
  await seed(alice, 'ada', 'ada.lovelace@acme.io', 'Partnership with Acme', 'Hi Ada, loved your analytical engine talk.');
  await seed(alice, 'grace', 'grace@navy.mil', 'Compilers chat', 'Grace, quick question about COBOL.', 'SENT');
  await seed(bob, 'bobacme', 'someone@acme.io', 'Acme for Bob', 'Bob private note');
  await search.indexEmails(Object.values(ids), { refresh: true });
});

afterAll(async () => {
  await search.drop();
  await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await prisma.sender.delete({ where: { id: senderId } });
  await closeQueues(queues);
  await conn.quit();
  await redis.quit();
  await prisma.$disconnect();
});

const find = (userId: string, qs: string) =>
  request(app).get(`/api/emails/search?${qs}`).set('Cookie', cookie(userId));

describe('email search (Elasticsearch)', () => {
  it('finds by partial address, as you type, with highlight markers', async () => {
    const res = await find(alice, 'q=lovel');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([ids.ada]);
    expect(res.body.items[0].highlights.toEmail[0]).toContain(`${HL_OPEN}lovelace${HL_CLOSE}`);
  });

  it('searches subject and body, tolerating typos', async () => {
    const subject = await find(alice, 'q=partnrship');
    expect(subject.body.items.map((i: { id: string }) => i.id)).toEqual([ids.ada]);
    expect(subject.body.approximate).toBe(true);
    const body = await find(alice, 'q=cobol');
    expect(body.body.items.map((i: { id: string }) => i.id)).toEqual([ids.grace]);
    expect(body.body.items[0].highlights.body[0]).toContain(`${HL_OPEN}COBOL${HL_CLOSE}`);
  });

  it('stays precise when there are exact/prefix matches (no fuzzy noise)', async () => {
    await seed(alice, 'lo1', 'load1@x.dev', 'load test', 'x');
    await seed(alice, 'lo12', 'load12@x.dev', 'load test', 'x');
    await seed(alice, 'lo2', 'load2@x.dev', 'load test', 'x');
    await search.indexEmails([ids.lo1!, ids.lo12!, ids.lo2!], { refresh: true });
    const res = await find(alice, 'q=load1');
    expect(res.body.approximate).toBe(false);
    expect(new Set(res.body.items.map((i: { id: string }) => i.id))).toEqual(new Set([ids.lo1, ids.lo12]));
  });

  it('never leaks another user’s emails', async () => {
    const res = await find(alice, 'q=acme');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([ids.ada]);
    const asBob = await find(bob, 'q=acme');
    expect(asBob.body.items.map((i: { id: string }) => i.id)).toEqual([ids.bobacme]);
  });

  it('filters by tab and returns fresh status from Postgres', async () => {
    expect((await find(alice, 'q=grace&status=scheduled')).body.total).toBe(0);
    const sent = await find(alice, 'q=grace&status=sent');
    expect(sent.body.items[0]).toMatchObject({ id: ids.grace, status: 'SENT' });
  });

  it('re-indexing after a status change moves the email between tabs', async () => {
    await prisma.email.update({ where: { id: ids.ada! }, data: { status: 'SENT', sentAt: new Date() } });
    await search.indexEmails([ids.ada!], { refresh: true });
    expect((await find(alice, 'q=ada&status=sent')).body.items[0].id).toBe(ids.ada);
    expect((await find(alice, 'q=ada&status=scheduled')).body.total).toBe(0);
  });

  it('removes documents whose rows no longer exist', async () => {
    const ghost = randomUUID();
    await expect(search.indexEmails([ghost], { refresh: true })).resolves.toBe(0);
  });

  it('validates the query and requires auth', async () => {
    expect((await find(alice, 'q=')).status).toBe(400);
    expect((await request(app).get('/api/emails/search?q=x')).status).toBe(401);
  });
});
