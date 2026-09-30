import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyLead, domainOf, MAX_LISTS, staticCheck } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { domainMail, lookupDomains, type MailResolver } from '../src/modules/leads/dns.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeUser, testPrefix } from './helpers.js';

const err = (code: string) => Object.assign(new Error(code), { code });

/** A resolver that answers from a table: domain → { mx?, a?, mxError?, aError? }. */
type Zone = Record<string, { mx?: string[]; a?: string[]; mxError?: string; aError?: string; delayMs?: number }>;
const fake = (zone: Zone, calls: string[] = []): MailResolver => ({
  resolveMx: async (d) => {
    calls.push(`mx:${d}`);
    const z = zone[d];
    if (z?.delayMs) await new Promise((r) => setTimeout(r, z.delayMs));
    if (!z) throw err('ENOTFOUND');
    if (z.mxError) throw err(z.mxError);
    if (!z.mx) throw err('ENODATA');
    return z.mx.map((exchange, priority) => ({ exchange, priority }));
  },
  resolve4: async (d) => {
    calls.push(`a:${d}`);
    const z = zone[d];
    if (!z) throw err('ENOTFOUND');
    if (z.aError) throw err(z.aError);
    if (!z.a) throw err('ENODATA');
    return z.a;
  },
});

describe('static checks (shared)', () => {
  it('flags role addresses, throwaway domains and typos from the address alone', () => {
    expect(staticCheck('ann@acme.test')).toEqual({});
    expect(staticCheck('INFO@acme.test')).toMatchObject({ status: 'RISKY', reason: 'role' });
    expect(staticCheck('support+vip@acme.test')).toMatchObject({ reason: 'role' });
    expect(staticCheck('ann@mailinator.com')).toMatchObject({ status: 'RISKY', reason: 'disposable' });
    expect(staticCheck('ann@gmial.com')).toEqual({ status: 'RISKY', reason: 'typo', suggestion: 'ann@gmail.com' });
    expect(staticCheck('not-an-email')).toMatchObject({ status: 'UNDELIVERABLE' });
    expect(domainOf('A@Example.COM')).toBe('example.com');
  });

  it('combines them with the domain lookup: undeliverable beats risky beats valid', () => {
    expect(classifyLead('ann@acme.test', 'accepts')).toEqual({ status: 'VALID', reason: null, suggestion: null });
    expect(classifyLead('info@acme.test', 'accepts')).toMatchObject({ status: 'RISKY', reason: 'role' });
    expect(classifyLead('info@acme.test', 'none')).toMatchObject({ status: 'UNDELIVERABLE', reason: 'no_mail_server' });
    expect(classifyLead('ann@acme.test', 'null_mx')).toMatchObject({ status: 'UNDELIVERABLE', reason: 'rejects_mail' });
    expect(classifyLead('ann@acme.test', 'unavailable')).toMatchObject({ status: 'UNKNOWN', reason: 'dns_unavailable' });
    expect(classifyLead('info@acme.test', 'unavailable')).toMatchObject({ status: 'RISKY' }); // a known risk still shows
    expect(classifyLead('ann@gmial.com', 'none')).toMatchObject({ status: 'UNDELIVERABLE', suggestion: 'ann@gmail.com' }); // and offers the fix
  });
});

describe('domain lookups', () => {
  it('accepts mail when there is an MX, or an address record as the fallback', async () => {
    expect(await domainMail('a.test', fake({ 'a.test': { mx: ['mx.a.test'] } }))).toBe('accepts');
    expect(await domainMail('b.test', fake({ 'b.test': { a: ['1.2.3.4'] } }))).toBe('accepts');
  });
  it('says none when neither exists, and null MX when the domain refuses mail', async () => {
    expect(await domainMail('c.test', fake({ 'c.test': {} }))).toBe('none');
    expect(await domainMail('missing.test', fake({}))).toBe('none');
    expect(await domainMail('d.test', fake({ 'd.test': { mx: [''] } }))).toBe('null_mx');
    expect(await domainMail('d.test', fake({ 'd.test': { mx: ['.'] } }))).toBe('null_mx');
  });
  it('reports unavailable (not "none") when the lookup itself fails', async () => {
    expect(await domainMail('e.test', fake({ 'e.test': { mxError: 'ESERVFAIL' } }))).toBe('unavailable');
    expect(await domainMail('f.test', fake({ 'f.test': { aError: 'ETIMEOUT' } }))).toBe('unavailable'); // no MX, then the fallback fails
    expect(await domainMail('slow.test', fake({ 'slow.test': { mx: ['x'], delayMs: 200 } }), 20)).toBe('unavailable'); // gave up waiting
  });
  it('looks each domain up once however many leads share it, and stops at its deadline', async () => {
    const calls: string[] = [];
    const zone: Zone = { 'a.test': { mx: ['m'] }, 'b.test': { mx: ['m'] } };
    const out = await lookupDomains(['a.test', 'b.test', 'a.test', 'a.test'], fake(zone, calls));
    expect([...out.entries()].sort()).toEqual([['a.test', 'accepts'], ['b.test', 'accepts']]);
    expect(calls.filter((c) => c === 'mx:a.test')).toHaveLength(1);
    const partial = await lookupDomains(['slow1.test', 'slow2.test', 'slow3.test'], fake({ 'slow1.test': { mx: ['m'], delayMs: 60 }, 'slow2.test': { mx: ['m'], delayMs: 60 }, 'slow3.test': { mx: ['m'], delayMs: 60 } }), { concurrency: 1, deadlineMs: 80 });
    expect(partial.size).toBeLessThan(3); // the rest are left for the next call
    expect(partial.size).toBeGreaterThan(0);
  });
});

describe('lead lists API', () => {
  const conn = createRedis('test-leadlists');
  const queues = createQueues(conn, testPrefix());
  const zone: Zone = { 'good.test': { mx: ['mx.good.test'] }, 'fallback.test': { a: ['9.9.9.9'] }, 'dead.test': {}, 'flaky.test': { mxError: 'ESERVFAIL' }, 'nomail.test': { mx: ['.'] }, 'gmial.com': { mx: ['mx.gmial.com'] }, 'mailinator.com': { mx: ['mx.mailinator.com'] } };
  const app = createApp({ queues, leads: { resolver: fake(zone) } });
  let userId: string;
  let otherId: string;

  beforeAll(async () => {
    userId = (await makeUser('leads')).id;
    otherId = (await makeUser('leads-other')).id;
    const keys = await redis.keys('reqlimit:verify:*');
    if (keys.length) await redis.del(...keys);
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
    del: (p: string) => request(app).delete(p).set('Cookie', cookieFor(id)),
  });
  const leads = [
    { email: 'ann@good.test', name: 'Ann', vars: { company: 'Acme' } },
    { email: 'bob@fallback.test' },
    { email: 'cy@dead.test' },
    { email: 'di@flaky.test' },
    { email: 'ed@nomail.test' },
    { email: 'info@good.test' },
    { email: 'fay@gmial.com' },
    { email: 'gus@mailinator.com' },
    { email: 'ANN@good.test' }, // duplicate by case
    { email: 'not-an-email' },
  ];
  async function fresh(name = 'Prospects', list: { email: string; name?: string; vars?: Record<string, string> }[] = leads) {
    await prisma.leadList.deleteMany({ where: { userId } });
    return (await as(userId).post('/api/lead-lists', { name, leads: list })).body as { id: string; total: number; counts: Record<string, number> };
  }

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/lead-lists')).status).toBe(401);
    expect((await request(app).post('/api/lead-lists/x/verify')).status).toBe(401);
  });

  it('creates a list: lowercased, de-duplicated, invalid addresses left out, nothing checked yet', async () => {
    const l = await fresh();
    expect(l.total).toBe(8);
    expect(l.counts).toEqual({ valid: 0, risky: 0, undeliverable: 0, unknown: 0, unchecked: 8 });
    const page = await as(userId).get(`/api/lead-lists/${l.id}/leads`);
    expect(page.body.items.map((i: { email: string }) => i.email)).toContain('ann@good.test');
    expect(page.body.items.every((i: { status: unknown }) => i.status === null)).toBe(true);
    expect((await as(userId).post('/api/lead-lists', { name: ' ', leads })).status).toBe(400);
    expect((await as(userId).post('/api/lead-lists', { name: 'x', leads: [{ email: 'nope' }] })).status).toBe(400);
  });

  it('verifies from the domain: valid, fallback, dead, unreachable, refusing, role, typo and throwaway', async () => {
    const l = await fresh();
    const res = await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checked: 8, remaining: 0, counts: { valid: 2, risky: 3, undeliverable: 2, unknown: 1, unchecked: 0 } });
    const all = (await as(userId).get(`/api/lead-lists/${l.id}/leads?limit=100`)).body.items as { email: string; status: string; reason: string | null; suggestion: string | null }[];
    const by = (e: string) => all.find((x) => x.email === e)!;
    expect(by('ann@good.test')).toMatchObject({ status: 'VALID', reason: null });
    expect(by('bob@fallback.test')).toMatchObject({ status: 'VALID' });
    expect(by('cy@dead.test')).toMatchObject({ status: 'UNDELIVERABLE', reason: 'no_mail_server' });
    expect(by('ed@nomail.test')).toMatchObject({ status: 'UNDELIVERABLE', reason: 'rejects_mail' });
    expect(by('di@flaky.test')).toMatchObject({ status: 'UNKNOWN', reason: 'dns_unavailable' });
    expect(by('info@good.test')).toMatchObject({ status: 'RISKY', reason: 'role' });
    expect(by('fay@gmial.com')).toMatchObject({ status: 'RISKY', reason: 'typo', suggestion: 'fay@gmail.com' });
    expect(by('gus@mailinator.com')).toMatchObject({ status: 'RISKY', reason: 'disposable' });
  });

  it('carries on where it left off: a second call only checks what is still unchecked', async () => {
    const l = await fresh();
    await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    await prisma.listLead.updateMany({ where: { listId: l.id, email: 'cy@dead.test' }, data: { status: null, reason: null, checkedAt: null } });
    const again = await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    expect(again.body.checked).toBe(1);
    expect(again.body.remaining).toBe(0);
  });

  it('filters the leads by verdict, including "unchecked"', async () => {
    const l = await fresh();
    expect((await as(userId).get(`/api/lead-lists/${l.id}/leads?status=UNCHECKED`)).body.total).toBe(8);
    await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    expect((await as(userId).get(`/api/lead-lists/${l.id}/leads?status=UNCHECKED`)).body.total).toBe(0);
    const risky = (await as(userId).get(`/api/lead-lists/${l.id}/leads?status=RISKY`)).body;
    expect(risky.total).toBe(3);
    expect(risky.items.every((i: { status: string }) => i.status === 'RISKY')).toBe(true);
    const p1 = (await as(userId).get(`/api/lead-lists/${l.id}/leads?limit=3`)).body;
    expect(p1.items).toHaveLength(3);
    const p2 = (await as(userId).get(`/api/lead-lists/${l.id}/leads?limit=3&cursor=${p1.nextCursor}`)).body;
    expect(p2.items[0].email).not.toBe(p1.items[0].email);
  });

  it('removes everything with a given verdict, and hands Compose the rest (keeping names and columns)', async () => {
    const l = await fresh();
    await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    const rec = (await as(userId).get(`/api/lead-lists/${l.id}/recipients`)).body as { email: string; name?: string; vars?: Record<string, string> }[];
    expect(rec.map((r) => r.email)).not.toContain('cy@dead.test'); // undeliverable left out by default
    expect(rec.map((r) => r.email)).toContain('di@flaky.test'); // unknown stays: we couldn't tell
    expect(rec.find((r) => r.email === 'ann@good.test')).toEqual({ email: 'ann@good.test', name: 'Ann', vars: { company: 'Acme' } });
    expect((await as(userId).get(`/api/lead-lists/${l.id}/recipients?includeUndeliverable=true`)).body).toHaveLength(8);

    const gone = await as(userId).del(`/api/lead-lists/${l.id}/leads?status=UNDELIVERABLE`);
    expect(gone.body).toEqual({ removed: 2 });
    expect((await as(userId).get(`/api/lead-lists/${l.id}`)).body.total).toBe(6);
    expect((await as(userId).del(`/api/lead-lists/${l.id}/leads?status=BOGUS`)).status).toBe(400);
  });

  it('exports CSV with readable verdicts, safe against spreadsheet formulas', async () => {
    const l = await fresh('Export', [{ email: 'ann@good.test', name: '=HYPERLINK("http://evil")' }, { email: 'cy@dead.test' }]);
    await as(userId).post(`/api/lead-lists/${l.id}/verify`);
    const res = await as(userId).get(`/api/lead-lists/${l.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('Export.csv');
    expect(res.text).toContain('Valid domain');
    expect(res.text).toContain('The domain has no mail server');
    expect(res.text).toContain("'=HYPERLINK"); // neutralised
    const only = (await as(userId).get(`/api/lead-lists/${l.id}/export?status=UNDELIVERABLE`)).text;
    expect(only).toContain('cy@dead.test');
    expect(only).not.toContain('ann@good.test');
  });

  it('is private to its owner, and lists can be deleted', async () => {
    const l = await fresh();
    for (const res of [await as(otherId).get(`/api/lead-lists/${l.id}`), await as(otherId).get(`/api/lead-lists/${l.id}/leads`), await as(otherId).post(`/api/lead-lists/${l.id}/verify`), await as(otherId).get(`/api/lead-lists/${l.id}/recipients`), await as(otherId).get(`/api/lead-lists/${l.id}/export`), await as(otherId).del(`/api/lead-lists/${l.id}`), await as(otherId).del(`/api/lead-lists/${l.id}/leads?status=VALID`)]) {
      expect(res.status).toBe(404);
    }
    expect((await as(otherId).get('/api/lead-lists')).body).toEqual([]);
    expect((await as(userId).del(`/api/lead-lists/${l.id}`)).status).toBe(204);
    expect(await prisma.listLead.count({ where: { listId: l.id } })).toBe(0); // its leads go with it
  });

  it('caps how many lists a person keeps', async () => {
    await prisma.leadList.deleteMany({ where: { userId } });
    for (let i = 0; i < MAX_LISTS; i++) expect((await as(userId).post('/api/lead-lists', { name: `l${i}`, leads: [{ email: `x${i}@good.test` }] })).status).toBe(201);
    const over = await as(userId).post('/api/lead-lists', { name: 'one more', leads: [{ email: 'y@good.test' }] });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/up to 20 lists/);
  });
});
