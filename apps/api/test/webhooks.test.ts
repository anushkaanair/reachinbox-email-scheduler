import { createHmac, randomUUID } from 'node:crypto';
import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_WEBHOOKS, WEBHOOK_DISABLE_AFTER, signedString, type WebhookPayload } from '@ri/shared';
import { createApp } from '../src/app.js';
import { decrypt } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { assertSafeUrl, buildPayload, postWebhook, signBody } from '../src/modules/webhooks/deliver.js';
import { createEmitter, deliverJob } from '../src/modules/webhooks/service.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeUser, testPrefix } from './helpers.js';

/** A receiver on 127.0.0.1 that records what it gets and answers as told. */
type Hit = { path: string; headers: http.IncomingHttpHeaders; body: string };
async function receiver(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_q, res) => res.writeHead(204).end()) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body });
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { hits, url: `http://127.0.0.1:${port}/hook`, port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const SECRET = 'whsec_test_secret';
const ping = () => buildPayload('ping', { hello: 'world' });

describe('signing', () => {
  it('HMAC-SHA256 over "<timestamp>.<body>", so a receiver can check it independently', () => {
    const expected = createHmac('sha256', 'k').update('1700000000.{"a":1}').digest('hex');
    expect(signBody('k', '1700000000', '{"a":1}')).toBe(expected);
    expect(signedString('1700000000', '{"a":1}')).toBe('1700000000.{"a":1}');
    expect(signBody('other', '1700000000', '{"a":1}')).not.toBe(expected);
    expect(signBody('k', '1700000001', '{"a":1}')).not.toBe(expected); // the timestamp is covered, so replays can be rejected
  });
});

describe('postWebhook', () => {
  it('sends a signed JSON POST with the identifying headers', async () => {
    const rx = await receiver();
    const payload = ping();
    const r = await postWebhook({ url: rx.url, secret: SECRET, payload, allowPrivate: true });
    expect(r).toEqual({ ok: true, status: 204 });
    const h = rx.hits[0]!;
    expect(h.path).toBe('/hook');
    expect(h.headers['content-type']).toBe('application/json');
    expect(h.headers['x-reachinbox-event']).toBe('ping');
    expect(h.headers['x-reachinbox-delivery']).toBe(payload.id);
    expect(JSON.parse(h.body)).toEqual(payload);
    const ts = h.headers['x-reachinbox-timestamp'] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    expect(h.headers['x-reachinbox-signature']).toBe(`sha256=${signBody(SECRET, ts, h.body)}`); // verifies on the raw body
    await rx.close();
  });

  it('reports a non-2xx answer, and never follows a redirect', async () => {
    const target = await receiver();
    const rx = await receiver((_q, res) => res.writeHead(302, { Location: target.url }).end());
    const r = await postWebhook({ url: rx.url, secret: SECRET, payload: ping(), allowPrivate: true });
    expect(r).toMatchObject({ ok: false, status: 302, error: expect.stringContaining('not followed') });
    expect(target.hits).toHaveLength(0); // the redirect target was never contacted
    const bad = await receiver((_q, res) => res.writeHead(500).end('boom'));
    expect(await postWebhook({ url: bad.url, secret: SECRET, payload: ping(), allowPrivate: true })).toMatchObject({ ok: false, status: 500, error: expect.stringContaining('500') });
    await Promise.all([target.close(), rx.close(), bad.close()]);
  });

  it('gives up on a slow receiver and survives a huge response', async () => {
    const slow = await receiver(() => undefined); // never answers
    const t0 = Date.now();
    expect(await postWebhook({ url: slow.url, secret: SECRET, payload: ping(), allowPrivate: true, timeoutMs: 150 })).toMatchObject({ ok: false, error: expect.stringContaining('Timed out') });
    expect(Date.now() - t0).toBeLessThan(2000);
    const big = await receiver((_q, res) => { res.writeHead(200); res.end('x'.repeat(5_000_000)); });
    expect(await postWebhook({ url: big.url, secret: SECRET, payload: ping(), allowPrivate: true })).toMatchObject({ ok: true, status: 200 });
    await Promise.all([slow.close(), big.close()]);
  });

  it('reports a connection that cannot be made', async () => {
    const rx = await receiver();
    const url = rx.url;
    await rx.close();
    expect(await postWebhook({ url, secret: SECRET, payload: ping(), allowPrivate: true })).toMatchObject({ ok: false, error: expect.stringContaining('connect') });
  });
});

describe('private network guard', () => {
  it('refuses addresses on a private network, without connecting', async () => {
    const rx = await receiver();
    for (const url of [rx.url, `http://localhost:${rx.port}/x`, `http://[::1]:${rx.port}/x`, 'http://10.0.0.5/x', 'http://192.168.1.10/x', 'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/x', 'http://[::ffff:10.0.0.1]/x', 'http://[::ffff:7f00:1]/x', 'http://[::ffff:a9fe:a9fe]/x', 'http://[fd00::1]/x', 'http://[64:ff9b::a00:1]/x']) {
      const r = await postWebhook({ url, secret: SECRET, payload: ping(), allowPrivate: false });
      expect(r.ok, url).toBe(false);
      expect(r.error, url).toMatch(/private network|Couldn’t find/);
    }
    expect(rx.hits).toHaveLength(0);
    await rx.close();
  });
  it('refuses other schemes and credentials in the URL', async () => {
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'https://user:pass@example.com/x']) {
      await expect(assertSafeUrl(url, false), url).rejects.toThrow();
    }
  });
  it('allows a public address', async () => {
    await expect(assertSafeUrl('https://93.184.216.34/hook', false)).resolves.toBeInstanceOf(URL);
  });
});

describe('webhooks API, fan-out and delivery', () => {
  const conn = createRedis('test-webhooks');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues, webhooks: { allowPrivate: true } });
  const strict = createApp({ queues, webhooks: { allowPrivate: false } });
  let userId: string;
  let otherId: string;
  let rx: Awaited<ReturnType<typeof receiver>>;
  const deps = { prisma, allowPrivate: true };

  beforeAll(async () => {
    userId = (await makeUser('hooks')).id;
    otherId = (await makeUser('hooks-other')).id;
    rx = await receiver();
  });
  afterAll(async () => {
    await rx.close();
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
  const as = (id: string, a = app) => ({
    get: (p: string) => request(a).get(p).set('Cookie', cookieFor(id)),
    post: (p: string, b?: object) => request(a).post(p).set('Cookie', cookieFor(id)).send(b),
    put: (p: string, b?: object) => request(a).put(p).set('Cookie', cookieFor(id)).send(b),
    del: (p: string) => request(a).delete(p).set('Cookie', cookieFor(id)),
  });
  const create = async (events = ['email.sent', 'email.failed'], extra: object = {}) => (await as(userId).post('/api/webhooks', { url: rx.url, events, ...extra })).body as { id: string; secret: string };
  const clear = () => prisma.webhook.deleteMany({ where: { userId: { in: [userId, otherId] } } });

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/webhooks')).status).toBe(401);
    expect((await request(app).post('/api/webhooks').send({})).status).toBe(401);
  });

  it('creates a webhook, shows the secret once, and stores it encrypted', async () => {
    await clear();
    const res = await as(userId).post('/api/webhooks', { url: rx.url, events: ['email.sent', 'email.sent', 'email.bounced'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(res.body).toMatchObject({ url: rx.url, events: ['email.sent', 'email.bounced'], active: true, campaignId: null, failureCount: 0 });
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.secretEnc).not.toContain('whsec_');
    expect(decrypt(row.secretEnc)).toBe(res.body.secret);
    const list = await as(userId).get('/api/webhooks');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('whsec_'); // never readable again
    expect(JSON.stringify(list.body)).not.toContain(row.secretEnc);
  });

  it('validates input, refuses private URLs (unless allowed), and caps the count', async () => {
    await clear();
    for (const bad of [{ url: 'nope', events: ['email.sent'] }, { url: rx.url, events: [] }, { url: rx.url, events: ['email.exploded'] }, { url: 'ftp://x.test/h', events: ['email.sent'] }, { events: ['email.sent'] }]) {
      expect((await as(userId).post('/api/webhooks', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const priv = await as(userId, strict).post('/api/webhooks', { url: rx.url, events: ['email.sent'] });
    expect(priv.status).toBe(422);
    expect(priv.body.error.message).toMatch(/private network/);
    expect(await prisma.webhook.count({ where: { userId } })).toBe(0);
    for (let i = 0; i < MAX_WEBHOOKS; i++) expect((await as(userId).post('/api/webhooks', { url: rx.url, events: ['email.sent'] })).status).toBe(201);
    const over = await as(userId).post('/api/webhooks', { url: rx.url, events: ['email.sent'] });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/up to 10 webhooks/);
  });

  it('only accepts a campaign filter that belongs to you', async () => {
    await clear();
    const res = await as(userId).post('/api/webhooks', { url: rx.url, events: ['email.sent'], campaignId: randomUUID() });
    expect(res.status).toBe(400);
  });

  it('is private to its owner', async () => {
    await clear();
    const { id } = await create();
    for (const r of [await as(otherId).put(`/api/webhooks/${id}`, { active: false }), await as(otherId).post(`/api/webhooks/${id}/test`), await as(otherId).post(`/api/webhooks/${id}/rotate-secret`), await as(otherId).get(`/api/webhooks/${id}/deliveries`), await as(otherId).del(`/api/webhooks/${id}`)]) {
      expect(r.status).toBe(404);
    }
    expect((await as(otherId).get('/api/webhooks')).body).toEqual([]);
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id } })).active).toBe(true);
  });

  it('"test" sends a signed ping with the real secret, and records the result either way', async () => {
    await clear();
    const { id, secret } = await create();
    rx.hits.length = 0;
    const ok = await as(userId).post(`/api/webhooks/${id}/test`);
    expect(ok.body).toEqual({ ok: true, status: 204 });
    const hit = rx.hits.at(-1)!;
    const ts = hit.headers['x-reachinbox-timestamp'] as string;
    expect(hit.headers['x-reachinbox-signature']).toBe(`sha256=${signBody(secret, ts, hit.body)}`);
    expect(JSON.parse(hit.body)).toMatchObject({ type: 'ping' });
    const deliveries = (await as(userId).get(`/api/webhooks/${id}/deliveries`)).body as { ok: boolean; event: string }[];
    expect(deliveries[0]).toMatchObject({ ok: true, event: 'ping', attempt: 1 });

    const dead = await receiver((_q, res) => res.writeHead(503).end());
    await as(userId).put(`/api/webhooks/${id}`, { url: dead.url });
    const fail = await as(userId).post(`/api/webhooks/${id}/test`);
    expect(fail.body).toMatchObject({ ok: false, status: 503 });
    expect(((await as(userId).get(`/api/webhooks/${id}/deliveries`)).body as { ok: boolean }[])[0]!.ok).toBe(false);
    await dead.close();
  });

  it('rotating the secret changes what deliveries are signed with', async () => {
    await clear();
    const { id, secret } = await create();
    const rotated = (await as(userId).post(`/api/webhooks/${id}/rotate-secret`)).body as { secret: string };
    expect(rotated.secret).not.toBe(secret);
    rx.hits.length = 0;
    await as(userId).post(`/api/webhooks/${id}/test`);
    const hit = rx.hits.at(-1)!;
    const ts = hit.headers['x-reachinbox-timestamp'] as string;
    expect(hit.headers['x-reachinbox-signature']).toBe(`sha256=${signBody(rotated.secret, ts, hit.body)}`);
    expect(hit.headers['x-reachinbox-signature']).not.toBe(`sha256=${signBody(secret, ts, hit.body)}`);
  });

  it('updates, switches on and off (switching on clears the failure count), and deletes with its history', async () => {
    await clear();
    const { id } = await create();
    await prisma.webhook.update({ where: { id }, data: { failureCount: 9, active: false } });
    const on = await as(userId).put(`/api/webhooks/${id}`, { active: true, events: ['campaign.auto_paused'] });
    expect(on.body).toMatchObject({ active: true, failureCount: 0, events: ['campaign.auto_paused'] });
    await as(userId).post(`/api/webhooks/${id}/test`);
    expect(await prisma.webhookDelivery.count({ where: { webhookId: id } })).toBe(1);
    expect((await as(userId).del(`/api/webhooks/${id}`)).status).toBe(204);
    expect(await prisma.webhookDelivery.count({ where: { webhookId: id } })).toBe(0);
  });

  it('fans an event out to matching webhooks only, and does no work when nobody listens', async () => {
    await clear();
    const all = await create(['email.sent']);
    const other = await create(['email.failed']);
    const camp = await prisma.campaign.create({ data: { userId, subject: 's', body: 'b', startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 10, totalRecipients: 0 } });
    const scoped = await create(['email.sent'], { campaignId: camp.id });
    await queues.notify.obliterate({ force: true });
    const emit = createEmitter(prisma, queues.notify, 0);
    let built = 0;
    const build = () => { built++; return { emailId: 'e1' }; };

    expect(await emit(userId, 'email.sent', 'some-other-campaign', build)).toBe(1); // `all` only: `scoped` is for one campaign
    expect(await emit(userId, 'email.sent', camp.id, build)).toBe(2); // `all` and `scoped`
    expect(await emit(userId, 'sender.paused', null, build)).toBe(0); // nobody asked for this event
    expect(await emit(otherId, 'email.sent', null, build)).toBe(0); // someone else's event
    expect(built).toBe(2); // the payload is only built when there is somewhere to send it
    const jobs = await queues.notify.getJobs(['waiting', 'delayed', 'active']);
    const targets = jobs.map((j) => (j.data as { webhookId: string }).webhookId).sort();
    expect(targets).toEqual([all.id, all.id, scoped.id].sort());
    expect(targets).not.toContain(other.id);
    expect(jobs[0]!.data).toMatchObject({ kind: 'webhook', payload: { type: 'email.sent', data: { emailId: 'e1' } } });
    await prisma.campaign.delete({ where: { id: camp.id } });
  });

  it('delivers a queued event end to end, and resets the failure count on success', async () => {
    await clear();
    const { id, secret } = await create(['email.bounced']);
    await prisma.webhook.update({ where: { id }, data: { failureCount: 3 } });
    const emit = createEmitter(prisma, queues.notify, 0);
    await queues.notify.obliterate({ force: true });
    await emit(userId, 'email.bounced', null, () => ({ to: 'nobody@example.test', error: '550 user unknown' }));
    const [job] = await queues.notify.getJobs(['waiting', 'delayed']);
    rx.hits.length = 0;
    await deliverJob(deps, job!.data as { webhookId: string; payload: WebhookPayload }, { made: 0, max: 5 });
    const hit = rx.hits.at(-1)!;
    expect(JSON.parse(hit.body)).toMatchObject({ type: 'email.bounced', data: { to: 'nobody@example.test' } });
    const ts = hit.headers['x-reachinbox-timestamp'] as string;
    expect(hit.headers['x-reachinbox-signature']).toBe(`sha256=${signBody(secret, ts, hit.body)}`);
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id } })).toMatchObject({ failureCount: 0, lastStatus: 'ok' });
  });

  it('failed deliveries throw (so the queue retries); only the last attempt counts, and too many in a row switch it off', async () => {
    await clear();
    const dead = await receiver((_q, res) => res.writeHead(500).end());
    const { id } = await create(['email.sent'], {});
    await prisma.webhook.update({ where: { id }, data: { url: dead.url } });
    const job = { webhookId: id, payload: buildPayload('email.sent', {}) };

    await expect(deliverJob(deps, job, { made: 0, max: 5 })).rejects.toThrow(/500/); // first try: retried, not yet counted
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id } })).failureCount).toBe(0);
    await expect(deliverJob(deps, job, { made: 4, max: 5 })).rejects.toThrow(); // the last try counts
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id } })).toMatchObject({ failureCount: 1, active: true, lastStatus: expect.stringContaining('500') });
    const attempts = (await prisma.webhookDelivery.findMany({ where: { webhookId: id }, orderBy: { createdAt: 'asc' } })).map((d) => d.attempt);
    expect(attempts).toEqual([1, 5]);

    await prisma.webhook.update({ where: { id }, data: { failureCount: WEBHOOK_DISABLE_AFTER - 1 } });
    await expect(deliverJob(deps, job, { made: 4, max: 5 })).rejects.toThrow();
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id } })).active).toBe(false);
    dead.hits.length = 0;
    await deliverJob(deps, job, { made: 0, max: 5 }); // switched off: skipped quietly, nothing is sent
    expect(dead.hits).toHaveLength(0);
    await dead.close();
  });

  it('keeps only the most recent deliveries', async () => {
    await clear();
    const { id } = await create();
    for (let i = 0; i < 53; i++) await deliverJob(deps, { webhookId: id, payload: buildPayload('email.sent', {}) }, { made: 0, max: 5 });
    expect(await prisma.webhookDelivery.count({ where: { webhookId: id } })).toBe(50);
  });
});
