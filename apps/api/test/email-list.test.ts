import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListEmailsResponseSchema, makePreview } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeSender, makeUser, testPrefix } from './helpers.js';

describe('makePreview', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(makePreview('  Hi   there,\n\n  how are   you?  ')).toBe('Hi there, how are you?');
    expect(makePreview('')).toBe('');
  });
  it('cuts long text at a word boundary with an ellipsis', () => {
    const long = `${'word '.repeat(60)}end`;
    const p = makePreview(long, 50);
    expect(p.endsWith('…')).toBe(true);
    expect(p.length).toBeLessThanOrEqual(51);
    expect(p).not.toMatch(/wor…$/); // no mid-word cut
    expect(makePreview('x'.repeat(200), 20)).toBe(`${'x'.repeat(20)}…`); // no spaces: hard cut
  });
});

describe('email list: preview, star and filters', () => {
  const conn = createRedis('test-email-list');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  let userId: string;
  let otherId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: 3_600_000 };

  beforeAll(async () => {
    userId = (await makeUser('list')).id;
    otherId = (await makeUser('list-other')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });
  const cookieFor = (id: string) => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
    return h;
  };
  const as = (id: string) => ({
    get: (p: string) => request(app).get(p).set('Cookie', cookieFor(id)),
    put: (p: string, b?: object) => request(app).put(p).set('Cookie', cookieFor(id)).send(b),
  });

  async function seed(n: number) {
    const s = await makeSender();
    senderIds.push(s.id);
    const body = 'Hello there,\n\n   I wanted   to follow up\non our meeting last week about the project.';
    const c = await createCampaign(userId, { subject: 'Follow up', body, leads: Array.from({ length: n }, (_, i) => ({ email: `l${i}-${randomUUID().slice(0, 6)}@x.dev` })), startAt: new Date(Date.now() + 86_400_000).toISOString(), delayBetweenSeconds: 0, hourlyLimit: 100, senderIds: [s.id] }, { prisma, queues, config: cfg });
    return { campaignId: c.campaignId, rows: await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } }) };
  }

  it('rows carry a collapsed body snippet and start unstarred', async () => {
    const { rows } = await seed(2);
    expect(rows[0]!.preview).toBe('Hello there, I wanted to follow up on our meeting last week about the project.');
    const res = await as(userId).get('/api/emails?status=scheduled');
    const parsed = ListEmailsResponseSchema.parse(res.body);
    const mine = parsed.items.find((r) => r.id === rows[0]!.id)!;
    expect(mine).toMatchObject({ preview: rows[0]!.preview, starred: false });
    const detail = await as(userId).get(`/api/emails/${rows[0]!.id}`);
    expect(detail.body).toMatchObject({ preview: rows[0]!.preview, starred: false });
  });

  it('stars and unstars, scoped to the owner', async () => {
    const { rows } = await seed(2);
    const id = rows[0]!.id;
    expect((await as(userId).put(`/api/emails/${id}/star`, { starred: true })).status).toBe(204);
    expect((await as(userId).get(`/api/emails/${id}`)).body.starred).toBe(true);
    expect((await as(userId).put(`/api/emails/${id}/star`, { starred: false })).status).toBe(204);
    expect((await as(userId).get(`/api/emails/${id}`)).body.starred).toBe(false);

    expect((await as(otherId).put(`/api/emails/${id}/star`, { starred: true })).status).toBe(404); // not theirs
    expect((await prisma.email.findUniqueOrThrow({ where: { id } })).starred).toBe(false);
    expect((await as(userId).put(`/api/emails/${id}/star`, { starred: 'yes' })).status).toBe(400);
    expect((await as(userId).put(`/api/emails/${randomUUID()}/star`, { starred: true })).status).toBe(404);
    expect((await request(app).put(`/api/emails/${id}/star`).send({ starred: true })).status).toBe(401);
  });

  it('the starred filter returns only starred emails', async () => {
    const { rows } = await seed(3);
    await as(userId).put(`/api/emails/${rows[1]!.id}/star`, { starred: true });
    const res = await as(userId).get('/api/emails?status=scheduled&starred=true&limit=100');
    const ids = (res.body.items as { id: string; starred: boolean }[]).map((r) => r.id);
    expect(ids).toContain(rows[1]!.id);
    expect(ids).not.toContain(rows[0]!.id);
    expect((res.body.items as { starred: boolean }[]).every((r) => r.starred)).toBe(true);
    expect((await as(userId).get('/api/emails?status=scheduled&starred=false')).status).toBe(400);
  });

  it('the outcome filter splits the Sent tab into delivered and failed', async () => {
    const { rows } = await seed(2);
    await prisma.email.update({ where: { id: rows[0]!.id }, data: { status: 'SENT', sentAt: new Date() } });
    await prisma.email.update({ where: { id: rows[1]!.id }, data: { status: 'FAILED', failedAt: new Date(), lastError: 'boom' } });
    const pick = async (q: string) => ((await as(userId).get(`/api/emails?status=sent&limit=100${q}`)).body.items as { id: string }[]).map((r) => r.id);
    expect(await pick('')).toEqual(expect.arrayContaining([rows[0]!.id, rows[1]!.id]));
    const sent = await pick('&outcome=SENT');
    expect(sent).toContain(rows[0]!.id);
    expect(sent).not.toContain(rows[1]!.id);
    const failed = await pick('&outcome=FAILED');
    expect(failed).toContain(rows[1]!.id);
    expect(failed).not.toContain(rows[0]!.id);
    // The outcome filter means nothing on the Scheduled tab, so it is ignored there.
    const scheduled = (await as(userId).get('/api/emails?status=scheduled&outcome=FAILED&limit=100')).body.items as { id: string }[];
    expect(scheduled.map((r) => r.id)).not.toContain(rows[1]!.id);
  });
  it('archives finished emails only; they leave the list and the counts, and come back when unarchived', async () => {
    const { rows } = await seed(3);
    const [sent, pendingRow] = [rows[0]!, rows[1]!];
    await prisma.email.update({ where: { id: sent.id }, data: { status: 'SENT', sentAt: new Date() } });
    const count = async () => (await as(userId).get('/api/emails/counts')).body as { scheduled: number; sent: number };
    const ids = async (q: string) => ((await as(userId).get(`/api/emails?limit=100${q}`)).body.items as { id: string }[]).map((r) => r.id);
    const before = await count();

    expect((await as(userId).put(`/api/emails/${pendingRow.id}/archive`, { archived: true })).status).toBe(409); // still waiting to send
    expect((await as(otherId).put(`/api/emails/${sent.id}/archive`, { archived: true })).status).toBe(404); // not theirs
    expect((await as(userId).put(`/api/emails/${randomUUID()}/archive`, { archived: true })).status).toBe(404);
    expect((await as(userId).put(`/api/emails/${sent.id}/archive`, { archived: 'yes' })).status).toBe(400);

    expect((await as(userId).put(`/api/emails/${sent.id}/archive`, { archived: true })).status).toBe(204);
    expect(await ids('&status=sent')).not.toContain(sent.id);
    expect(await ids('&status=sent&archived=true')).toContain(sent.id);
    expect((await as(userId).get(`/api/emails/${sent.id}`)).body.archived).toBe(true);
    expect((await count()).sent).toBe(before.sent - 1);

    expect((await as(userId).put(`/api/emails/${sent.id}/archive`, { archived: false })).status).toBe(204);
    expect(await ids('&status=sent')).toContain(sent.id);
    expect((await count()).sent).toBe(before.sent);
  });
});
