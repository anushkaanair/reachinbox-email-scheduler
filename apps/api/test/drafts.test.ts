import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftTitle, DraftPayloadSchema, MAX_DRAFTS } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeUser, testPrefix } from './helpers.js';

describe('draft payload (shared)', () => {
  it('fills in sensible defaults for an almost-empty form', () => {
    expect(DraftPayloadSchema.parse({})).toMatchObject({ subject: '', body: '', leads: [], sendAt: null, delayBetweenSeconds: 2, hourlyLimit: 50, jitterPercent: 0 });
  });
  it('titles a draft by its subject, or says there is none yet', () => {
    expect(draftTitle({ subject: '  Quick question  ' })).toBe('Quick question');
    expect(draftTitle({ subject: '   ' })).toBe('(no subject yet)');
    expect(draftTitle({ subject: 'x'.repeat(500) }).length).toBe(120);
  });
  it('rejects nonsense', () => {
    for (const bad of [{ jitterPercent: 90 }, { hourlyLimit: 0 }, { delayBetweenSeconds: -1 }, { subject: 'x'.repeat(301) }, { sendAt: 'tomorrow' }, { leads: [{ name: 'no email' }] }]) {
      expect(DraftPayloadSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('drafts API', () => {
  const conn = createRedis('test-drafts');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    userId = (await makeUser('drafts')).id;
    otherId = (await makeUser('drafts-other')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await conn.quit();
  });
  const cookieFor = (id: string) => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
    return h;
  };
  const as = (id: string) => ({
    get: (p: string) => request(app).get(p).set('Cookie', cookieFor(id)),
    post: (p: string, b?: object) => request(app).post(p).set('Cookie', cookieFor(id)).send(b),
    put: (p: string, b?: object) => request(app).put(p).set('Cookie', cookieFor(id)).send(b),
    del: (p: string) => request(app).delete(p).set('Cookie', cookieFor(id)),
  });
  const form = { subject: 'Follow up', body: '<p>Hi <b>{{name}}</b></p>', leads: [{ email: 'a@x.dev', name: 'Ann' }, { email: 'b@x.dev' }], sendAt: new Date(Date.now() + 86_400_000).toISOString(), delayBetweenSeconds: 5, hourlyLimit: 20, jitterPercent: 10, senderId: '' };

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/drafts')).status).toBe(401);
    expect((await request(app).post('/api/drafts').send(form)).status).toBe(401);
  });

  it('saves, lists, opens, updates and deletes a draft', async () => {
    const created = await as(userId).post('/api/drafts', form);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Follow up', recipients: 2 });

    const list = await as(userId).get('/api/drafts');
    expect(list.body).toEqual([expect.objectContaining({ id: created.body.id, title: 'Follow up', recipients: 2 })]);
    expect(JSON.stringify(list.body)).not.toContain('a@x.dev'); // the list carries no recipient data

    const opened = await as(userId).get(`/api/drafts/${created.body.id}`);
    expect(opened.body.payload).toMatchObject({ subject: 'Follow up', body: '<p>Hi <b>{{name}}</b></p>', hourlyLimit: 20, jitterPercent: 10, delayBetweenSeconds: 5 });
    expect(opened.body.payload.leads).toHaveLength(2);

    const updated = await as(userId).put(`/api/drafts/${created.body.id}`, { ...form, subject: 'Changed', leads: [{ email: 'c@x.dev' }] });
    expect(updated.body).toMatchObject({ id: created.body.id, title: 'Changed', recipients: 1 });
    expect((await as(userId).get('/api/drafts')).body).toHaveLength(1); // updated in place, not duplicated

    expect((await as(userId).del(`/api/drafts/${created.body.id}`)).status).toBe(204);
    expect((await as(userId).get('/api/drafts')).body).toEqual([]);
    expect((await as(userId).get(`/api/drafts/${created.body.id}`)).status).toBe(404);
  });

  it('is private to its owner', async () => {
    const d = await as(userId).post('/api/drafts', form);
    expect((await as(otherId).get('/api/drafts')).body).toEqual([]);
    expect((await as(otherId).get(`/api/drafts/${d.body.id}`)).status).toBe(404);
    expect((await as(otherId).put(`/api/drafts/${d.body.id}`, form)).status).toBe(404);
    expect((await as(otherId).del(`/api/drafts/${d.body.id}`)).status).toBe(404);
    expect((await as(userId).get(`/api/drafts/${d.body.id}`)).status).toBe(200); // untouched
  });

  it('validates input and caps how many drafts a person keeps', async () => {
    expect((await as(userId).post('/api/drafts', { ...form, jitterPercent: 99 })).status).toBe(400);
    expect((await as(userId).post('/api/drafts', { ...form, leads: [{ nope: 1 }] })).status).toBe(400);
    await prisma.draft.deleteMany({ where: { userId } });
    for (let i = 0; i < MAX_DRAFTS; i++) expect((await as(userId).post('/api/drafts', { ...form, subject: `d${i}` })).status).toBe(201);
    const over = await as(userId).post('/api/drafts', form);
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/up to 20 drafts/);
  });

  it('a draft is only data: it creates no emails and queues nothing', async () => {
    await prisma.draft.deleteMany({ where: { userId } });
    const before = { emails: await prisma.email.count({ where: { userId } }), campaigns: await prisma.campaign.count({ where: { userId } }), jobs: await queues.email.getJobCounts() };
    await as(userId).post('/api/drafts', form);
    expect({ emails: await prisma.email.count({ where: { userId } }), campaigns: await prisma.campaign.count({ where: { userId } }), jobs: await queues.email.getJobCounts() }).toEqual(before);
  });
});
