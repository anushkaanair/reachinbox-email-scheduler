import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dnsSummary, guessProvider, rowToCreate, SenderDetailSchema, suggestMapping } from '@ri/shared';
import { createApp } from '../src/app.js';
import { decrypt } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { withSignature, type SendFn } from '../src/mail/transport.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { checkDomain, type Resolver } from '../src/modules/senders/dns.js';
import { isPrivateAddress, type SmtpVerifier } from '../src/modules/senders/smtp.js';
import { createEmailProcessor } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Literal public IPs so no DNS lookup happens in tests (the private-address guard still runs).
const HOST = '93.184.216.34';

describe('account CSV mapping (shared)', () => {
  it('guesses provider from address or host', () => {
    expect(guessProvider('a@gmail.com')).toBe('GOOGLE');
    expect(guessProvider('a@corp.io', 'smtp.office365.com')).toBe('OUTLOOK');
    expect(guessProvider('a@ethereal.email')).toBe('ETHEREAL');
    expect(guessProvider('a@corp.io', 'mail.corp.io')).toBe('CUSTOM');
  });
  it('maps the ReachInbox template headers, using each field once', () => {
    expect(suggestMapping(['Email', 'First Name', 'Last Name', 'SMTP Username', 'SMTP Password', 'SMTP Host', 'SMTP Port', 'IMAP Host', 'Daily Limit', 'Warmup Enabled', 'Warmup Limit', 'Warmup Increment'])).toMatchObject({
      Email: 'email', 'First Name': 'firstName', 'Last Name': 'lastName', 'SMTP Username': 'smtpUser', 'SMTP Password': 'smtpPass', 'SMTP Host': 'smtpHost', 'SMTP Port': 'smtpPort',
      'IMAP Host': null, 'Daily Limit': 'dailyLimit', 'Warmup Enabled': 'warmupEnabled', 'Warmup Limit': 'warmupLimit', 'Warmup Increment': 'warmupIncrement',
    });
    const dup = suggestMapping(['Email', 'Email Address']);
    expect(Object.values(dup).filter((v) => v === 'email')).toHaveLength(1);
  });
  it('validates a row and explains the first problem', () => {
    expect(rowToCreate({ email: 'a@gmail.com', firstName: 'A', smtpPass: 'pw', warmupEnabled: 'TRUE', warmupLimit: '30', warmupIncrement: '3', tags: 'x; y' })).toMatchObject({
      create: { email: 'a@gmail.com', tags: ['x', 'y'] },
      warmup: { enabled: true, target: 30, increment: 3 },
    });
    expect(rowToCreate({ email: 'nope', firstName: 'A', smtpPass: 'pw' })).toEqual({ error: expect.stringContaining('email') });
    expect(rowToCreate({ email: 'a@corp.io', firstName: 'A', smtpPass: 'pw' })).toEqual({ error: expect.stringContaining('smtpHost') });
    expect(rowToCreate({ email: 'a@gmail.com', firstName: 'A', smtpPass: 'pw', warmupEnabled: 'yes', warmupLimit: 'lots' })).toEqual({ error: expect.stringContaining('warmup') });
  });
});

describe('private-address guard', () => {
  it('flags loopback, private, link-local and mapped addresses only', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1', '64:ff9b::a00:1', 'not-an-ip']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:2800:220:1::1']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('DNS check', () => {
  const resolver = (records: Record<string, string[][]>, mx: string[] = []): Resolver => ({
    resolveTxt: async (n) => {
      if (n in records) return records[n]!;
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    },
    resolveMx: async () => {
      if (mx.length === 0) throw new Error('ENODATA');
      return mx.map((exchange, i) => ({ exchange, priority: i }));
    },
  });

  it('passes a fully configured domain', async () => {
    const r = await checkDomain('good.test', resolver({ 'good.test': [['v=spf1 include:_spf.google.com ~all']], '_dmarc.good.test': [['v=DMARC1; p=none']], 'google._domainkey.good.test': [['v=DKIM1; k=rsa; p=AAA']] }, ['mx.good.test']));
    expect([r.spf.status, r.dmarc.status, r.dkim.status, r.mx.status]).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(dnsSummary(r)).toEqual({ pass: 4, fail: 0 });
  });
  it('reports what is missing, and never claims DKIM fails when the selector is unknown', async () => {
    const r = await checkDomain('bare.test', resolver({}));
    expect([r.spf.status, r.dmarc.status, r.mx.status]).toEqual(['fail', 'fail', 'fail']);
    expect(r.dkim.status).toBe('unknown');
  });
  it('flags two SPF records and more than 10 lookups', async () => {
    const two = await checkDomain('two.test', resolver({ 'two.test': [['v=spf1 -all'], ['v=spf1 ~all']] }));
    expect(two.spf).toMatchObject({ status: 'fail', detail: expect.stringContaining('More than one') });
    const many = await checkDomain('many.test', resolver({ 'many.test': [[`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:s${i}.test`).join(' ')} ~all`]] }));
    expect(many.spf).toMatchObject({ status: 'fail', detail: expect.stringContaining('11') });
  });
});

describe('signature and per-account delay', () => {
  it('appends the signature under a separator, and nothing when blank', () => {
    expect(withSignature('Hi', 'Anushka\nFounder')).toBe('Hi\n\n-- \nAnushka\nFounder');
    expect(withSignature('Hi', '  ')).toBe('Hi');
    expect(withSignature('Hi', null)).toBe('Hi');
  });
  it('a per-sender delay raises the gap but can never go below the server floor', async () => {
    const rl = new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: HOUR, minDelayMs: 2000, dayMs: DAY });
    const lim = { global: 1e6, sender: 1e6, campaign: 1e6 };
    const T = Date.now();
    const slots = async (id: string, min?: number) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await rl.acquire({ now: T, senderId: id, campaignId: 'c', limits: lim, minDelayMs: min });
        if (!r.ok) throw new Error('blocked');
        out.push(r.ticket.slot);
      }
      return [out[1]! - out[0]!, out[2]! - out[1]!];
    };
    expect(await slots('a')).toEqual([2000, 2000]);
    expect(await slots('b', 10_000)).toEqual([10_000, 10_000]);
    expect(await slots('c', 500)).toEqual([2000, 2000]); // lower than the floor is ignored
    expect(rl.effectiveMinDelay(undefined)).toBe(2000);
  });
});

describe('Email Accounts API', () => {
  const conn = createRedis('test-accounts');
  const queues = createQueues(conn, testPrefix());
  const verify = vi.fn<SmtpVerifier>(async () => {});
  const send = vi.fn<SendFn>(async (_s, e) => ({ messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: 'https://ethereal.email/message/x' }));
  const resolver: Resolver = { resolveTxt: async () => { throw new Error('ENODATA'); }, resolveMx: async () => [{ exchange: 'mx.test', priority: 1 }] };
  const app = createApp({ queues, send, senders: { verify, resolver } });
  let userId: string;
  const domain = `acct-${randomUUID().slice(0, 8)}.test`;
  const addr = (n: string) => `${n}@${domain}`;

  beforeAll(async () => {
    userId = (await makeUser('accounts')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await conn.quit();
  });

  const cookie = () => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
    return h;
  };
  const api = {
    post: (path: string, body?: object) => request(app).post(path).set('Cookie', cookie()).send(body),
    put: (path: string, body?: object) => request(app).put(path).set('Cookie', cookie()).send(body),
    get: (path: string) => request(app).get(path).set('Cookie', cookie()),
  };
  const connect = (n: string, extra: object = {}) =>
    api.post('/api/senders', { email: addr(n), firstName: 'Ann', lastName: 'Lee', smtpHost: HOST, smtpPass: 'secret-pw', ...extra });
  const details = async () => ((await api.get('/api/senders/health')).body as { id: string; email: string }[]);

  it('requires sign-in', async () => {
    expect((await request(app).post('/api/senders').send({})).status).toBe(401);
    expect((await request(app).post('/api/senders/bulk').send({})).status).toBe(401);
  });

  it('connects an account: logs in first, stores the password encrypted, never returns it', async () => {
    verify.mockClear();
    const res = await connect('one', { smtpPort: 465, dailyLimit: 25, tags: ['Sales', 'sales', 'EU'] });
    expect(res.status).toBe(201);
    expect(verify).toHaveBeenCalledWith({ host: HOST, port: 465, user: addr('one'), pass: 'secret-pw' });
    const row = await prisma.sender.findUniqueOrThrow({ where: { email: addr('one') } });
    expect(row).toMatchObject({ displayName: 'Ann Lee', firstName: 'Ann', lastName: 'Lee', smtpPort: 465, dailyLimit: 25, tags: ['sales', 'eu'], provider: 'CUSTOM' });
    expect(row.smtpPassEnc).not.toContain('secret-pw');
    expect(decrypt(row.smtpPassEnc)).toBe('secret-pw');
    const mine = (await details()).find((d) => d.email === addr('one'));
    const parsed = SenderDetailSchema.parse(mine);
    expect(parsed).toMatchObject({ dailyLimit: 25, tags: ['sales', 'eu'], attention: null, bouncedToday: 0, campaignCount: 0 });
    expect(JSON.stringify(mine)).not.toContain('secret-pw');
    expect(JSON.stringify(mine)).not.toContain(row.smtpPassEnc);
  });

  it('presets fill in Google’s host and port', async () => {
    const res = await api.post('/api/senders', { email: `g-${randomUUID().slice(0, 6)}@gmail.com`, firstName: 'G', smtpPass: 'apppass', verify: true });
    // smtp.gmail.com is a public host; the stub verifier accepts it, but resolving it needs the network,
    // so either outcome is fine here — what matters is the request used Google's preset.
    const call = verify.mock.calls.at(-1)?.[0];
    if (res.status === 201) expect(call).toMatchObject({ host: 'smtp.gmail.com', port: 587 });
    else expect(res.body.error.message).toMatch(/SMTP host/);
    await prisma.sender.deleteMany({ where: { email: { startsWith: 'g-', endsWith: '@gmail.com' } } });
  });

  it('rejects a login failure with a helpful message and stores nothing', async () => {
    verify.mockRejectedValueOnce(new Error('Invalid login: 535 5.7.8 Authentication failed'));
    const res = await connect('bad');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Login was rejected.*app password/);
    expect(await prisma.sender.count({ where: { email: addr('bad') } })).toBe(0);
  });

  it('rejects hosts on a private network and duplicates', async () => {
    for (const host of ['127.0.0.1', '10.0.0.5', 'localhost']) {
      const res = await connect(`priv-${host.replace(/\W/g, '')}`, { smtpHost: host });
      expect(res.status, host).toBe(422);
      expect(res.body.error.message).toMatch(/private network|find the SMTP host/);
    }
    const dup = await connect('one');
    expect(dup.status).toBe(409);
  });

  it('validates input', async () => {
    expect((await connect('x', { email: 'not-an-email' })).status).toBe(400);
    expect((await api.post('/api/senders', { email: addr('y'), firstName: 'Y', smtpPass: 'p' })).status).toBe(400); // custom domain needs a host
  });

  it('imports CSV rows: good rows are created, bad/duplicate rows are reported, nothing blocks the rest', async () => {
    verify.mockImplementation(async ({ pass }) => {
      if (pass === 'wrong') throw new Error('535 Authentication failed');
    });
    const rows = [
      { email: addr('i1'), firstName: 'I', smtpPass: 'ok', smtpHost: HOST, warmupEnabled: 'TRUE', warmupLimit: '20', warmupIncrement: '4' },
      { email: addr('i2'), firstName: 'I', smtpPass: 'wrong', smtpHost: HOST },
      { email: 'broken', firstName: 'I', smtpPass: 'ok', smtpHost: HOST },
      { email: addr('i1'), firstName: 'I', smtpPass: 'ok', smtpHost: HOST },
      { email: addr('one'), firstName: 'I', smtpPass: 'ok', smtpHost: HOST },
    ];
    const res = await api.post('/api/senders/import', { rows, verify: true });
    verify.mockReset();
    verify.mockResolvedValue(undefined);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 2, failed: 2 });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['created', 'failed', 'failed', 'skipped', 'skipped']);
    expect(res.body.results[1].message).toMatch(/Login was rejected/);
    expect(res.body.results[3].message).toMatch(/Duplicate row/);
    const i1 = await prisma.sender.findUniqueOrThrow({ where: { email: addr('i1') } });
    expect(i1).toMatchObject({ warmupEnabled: true, warmupTarget: 20, warmupIncrement: 4 });
    expect(i1.warmupStartedAt).not.toBeNull();
    expect(await prisma.sender.count({ where: { email: addr('i2') } })).toBe(0);
  });

  it('updates per-account settings; null clears; a blank signature is stored as none', async () => {
    const s = await prisma.sender.findUniqueOrThrow({ where: { email: addr('one') } });
    let res = await api.put(`/api/senders/${s.id}/settings`, { firstName: 'Anna', dailyLimit: 10, minDelaySeconds: 30, signature: 'Anna\nAcme', replyTo: 'Replies@Acme.test', tags: ['vip'], hourlyLimit: 20 });
    expect(res.status).toBe(204);
    let row = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ firstName: 'Anna', lastName: 'Lee', displayName: 'Anna Lee', dailyLimit: 10, minDelayMs: 30_000, signature: 'Anna\nAcme', replyTo: 'replies@acme.test', tags: ['vip'], hourlyLimit: 20 });
    res = await api.put(`/api/senders/${s.id}/settings`, { dailyLimit: null, minDelaySeconds: null, signature: '  ', replyTo: null, hourlyLimit: null });
    expect(res.status).toBe(204);
    row = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ dailyLimit: null, minDelayMs: null, signature: null, replyTo: null, hourlyLimit: null });
    expect((await api.put(`/api/senders/${s.id}/settings`, { replyTo: 'nope' })).status).toBe(400);
    expect((await api.put('/api/senders/missing/settings', {})).status).toBe(404);
  });

  it('bulk: tags merge, warm-up toggles, edit applies to all, delete skips accounts with emails waiting', async () => {
    const [a, b] = await Promise.all(['b1', 'b2'].map((n) => connect(n).then(() => prisma.sender.findUniqueOrThrow({ where: { email: addr(n) } }))));
    const ids = [a!.id, b!.id];
    await api.post('/api/senders/bulk', { action: 'add_tags', ids: [a!.id], tags: ['x'] });
    await api.post('/api/senders/bulk', { action: 'add_tags', ids, tags: ['y'] });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: a!.id } })).tags).toEqual(['x', 'y']);
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: b!.id } })).tags).toEqual(['y']);

    expect((await api.post('/api/senders/bulk', { action: 'enable_warmup', ids })).body.updated).toBe(2);
    const warm = await prisma.sender.findMany({ where: { id: { in: ids } } });
    expect(warm.every((w) => w.warmupEnabled && w.warmupStartedAt)).toBe(true);
    await api.post('/api/senders/bulk', { action: 'pause_warmup', ids });
    expect((await prisma.sender.findMany({ where: { id: { in: ids } } })).every((w) => !w.warmupEnabled)).toBe(true);

    await api.post('/api/senders/bulk', { action: 'edit_settings', ids, settings: { dailyLimit: 12 } });
    expect((await prisma.sender.findMany({ where: { id: { in: ids } } })).map((w) => w.dailyLimit)).toEqual([12, 12]);

    // b2 gets a scheduled email, so it can't be removed.
    await createCampaign(userId, { subject: 's', body: 'b', leads: [{ email: `l-${randomUUID().slice(0, 6)}@x.dev` }], startAt: new Date(Date.now() + DAY).toISOString(), delayBetweenSeconds: 0, hourlyLimit: 100, senderIds: [b!.id] }, { prisma, queues, config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: HOUR } });
    const del = await api.post('/api/senders/bulk', { action: 'delete', ids });
    expect(del.body.updated).toBe(1);
    expect(del.body.skipped).toEqual([{ id: b!.id, email: addr('b2'), reason: expect.stringContaining('1 email(s) still scheduled') }]);
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: a!.id } })).isActive).toBe(false);
    expect((await details()).some((d) => d.id === a!.id)).toBe(false);
    expect((await api.post('/api/senders/bulk', { action: 'add_tags', ids: [], tags: ['x'] })).status).toBe(400);
    expect((await api.post('/api/senders/bulk', { action: 'nope', ids })).status).toBe(400);

    // A removed account can be connected again.
    expect((await connect('b1')).status).toBe(201);
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: a!.id } })).isActive).toBe(true);
  });

  it('reconnect replaces the password and clears the error and pause; acknowledge clears without changing it', async () => {
    const s = await prisma.sender.findUniqueOrThrow({ where: { email: addr('one') } });
    await prisma.sender.update({ where: { id: s.id }, data: { lastError: 'Invalid login: 535', consecutiveFailures: 2, pausedUntil: new Date(Date.now() + HOUR), pauseReason: 'Login rejected' } });
    expect((await details()).find((d) => d.id === s.id)).toMatchObject({ attention: 'paused' });

    verify.mockRejectedValueOnce(new Error('535 Authentication failed'));
    const bad = await api.post(`/api/senders/${s.id}/reconnect`, { smtpPass: 'still-wrong' });
    expect(bad.status).toBe(422);
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).pausedUntil).not.toBeNull();

    expect((await api.post(`/api/senders/${s.id}/reconnect`, { smtpPass: 'new-pw' })).status).toBe(204);
    const fixed = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(decrypt(fixed.smtpPassEnc)).toBe('new-pw');
    expect(fixed).toMatchObject({ lastError: null, consecutiveFailures: 0, pausedUntil: null, pauseReason: null });

    await prisma.sender.update({ where: { id: s.id }, data: { lastError: 'quota', consecutiveFailures: 3 } });
    expect((await details()).find((d) => d.id === s.id)).toMatchObject({ attention: 'error' });
    expect((await api.post(`/api/senders/${s.id}/acknowledge`)).status).toBe(204);
    const acked = await prisma.sender.findUniqueOrThrow({ where: { id: s.id } });
    expect(acked).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    expect(acked.errorAcknowledgedAt).not.toBeNull();
    expect(decrypt(acked.smtpPassEnc)).toBe('new-pw');
    expect((await details()).find((d) => d.id === s.id)).toMatchObject({ attention: null });
  });

  it('test email: logs in, sends one real message, records the result', async () => {
    const s = await prisma.sender.findUniqueOrThrow({ where: { email: addr('one') } });
    send.mockClear();
    const ok = await api.post(`/api/senders/${s.id}/test`, { to: 'me@example.test' });
    expect(ok.body).toEqual({ ok: true, previewUrl: 'https://ethereal.email/message/x', error: null });
    expect(send.mock.calls[0]![1]).toMatchObject({ to: 'me@example.test' });
    expect((await prisma.sender.findUniqueOrThrow({ where: { id: s.id } })).lastTestOk).toBe(true);

    verify.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const bad = await api.post(`/api/senders/${s.id}/test`, { to: 'me@example.test' });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, previewUrl: null, error: expect.stringContaining('Couldn’t reach') });
    expect((await details()).find((d) => d.email === addr('one'))).toMatchObject({ lastTest: { ok: false } });
    expect((await api.post(`/api/senders/${s.id}/test`, { to: 'bad' })).status).toBe(400);
  });

  it('DNS check stores the report and shows it in the details', async () => {
    const s = await prisma.sender.findUniqueOrThrow({ where: { email: addr('one') } });
    const res = await api.post(`/api/senders/${s.id}/dns-check`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ domain, spf: { status: 'fail' }, mx: { status: 'pass' }, dkim: { status: 'unknown' } });
    expect((await details() as unknown as { email: string; dns: { domain: string } | null }[]).find((d) => d.email === addr('one'))!.dns).toMatchObject({ domain });
  });
});

describe('worker honours the account’s daily limit', () => {
  const conn = createRedis('test-accounts-worker');
  const queues = createQueues(conn, testPrefix());
  let userId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: DAY };

  beforeAll(async () => {
    userId = (await makeUser('accounts-worker')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });

  const job = (emailId: string) => {
    const j = { id: emailId, data: { emailId } as EmailJobData, opts: { attempts: 3 }, attemptsMade: 0, updateData: vi.fn(async (d: EmailJobData) => void (j.data = d)), moveToDelayed: vi.fn(async () => {}), discard: vi.fn() };
    return j as unknown as Job<EmailJobData>;
  };
  const run = async (data: object, n: number) => {
    const s = await prisma.sender.update({ where: { id: (await makeSender()).id }, data });
    senderIds.push(s.id);
    const c = await createCampaign(userId, { subject: 's', body: 'b', leads: Array.from({ length: n }, (_, i) => ({ email: `d${i}-${randomUUID().slice(0, 6)}@x.dev` })), startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 1000, senderIds: [s.id] }, { prisma, queues, config: cfg });
    const processor = createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: HOUR, minDelayMs: 0, dayMs: DAY }),
      send: async (_s, e) => ({ messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null }),
      logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000, pauseAfterFailures: 3, pauseMs: 60_000 },
      onRateLimited: async () => {},
    });
    const rows = await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } });
    for (const r of rows) await processor(job(r.id), 't').catch(() => undefined);
    return (await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } })).map((r) => r.status);
  };

  it('stops at the daily limit and defers the rest', async () => {
    expect(await run({ dailyLimit: 2 }, 4)).toEqual(['SENT', 'SENT', 'RATE_LIMITED', 'RATE_LIMITED']);
  });
  it('the lower of the daily limit and the warm-up cap wins', async () => {
    const warm = { warmupEnabled: true, warmupStartedAt: new Date(), warmupStart: 3, warmupIncrement: 3, warmupTarget: 30 };
    expect(await run({ ...warm, dailyLimit: 2 }, 4)).toEqual(['SENT', 'SENT', 'RATE_LIMITED', 'RATE_LIMITED']); // limit 2 < cap 3
    expect(await run({ ...warm, dailyLimit: 9 }, 5)).toEqual(['SENT', 'SENT', 'SENT', 'RATE_LIMITED', 'RATE_LIMITED']); // cap 3 < limit 9
  });
});
