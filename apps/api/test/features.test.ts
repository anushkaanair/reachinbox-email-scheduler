import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isInSendWindow, nextSendWindowStart, renderTemplate, spin, type SendWindow } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import type { SendFn } from '../src/mail/transport.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { createEmailProcessor } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const DAY = 86_400_000;
const conn = createRedis('test-features');
const queues = createQueues(conn, testPrefix());
const sendMock = vi.fn<SendFn>(async (_s, e) => ({ messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: 'https://ethereal.email/message/abc' }));
const app = createApp({ queues, send: sendMock });
const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: DAY };

let userId: string;
let otherId: string;
let senderId: string;

const cookieFor = (id: string) => {
  let h = '';
  setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
  return h;
};
const cookie = () => cookieFor(userId);
const state = (id: string) => queues.email.getJobState(id);
const tag = () => Math.random().toString(36).slice(2, 8);

async function campaign(emails: string[], extra: Record<string, unknown> = {}, startInMs = DAY) {
  const res = await createCampaign(
    userId,
    {
      subject: 'S {{name}}',
      body: 'B',
      leads: emails.map((email) => ({ email })),
      startAt: new Date(Date.now() + startInMs).toISOString(),
      delayBetweenSeconds: 0,
      hourlyLimit: 1000,
      senderIds: [senderId],
      ...extra,
    },
    { prisma, queues, config: cfg },
  );
  const rows = await prisma.email.findMany({ where: { campaignId: res.campaignId }, orderBy: { sequence: 'asc' } });
  return { ...res, rows };
}

beforeAll(async () => {
  userId = (await makeUser('feat')).id;
  otherId = (await makeUser('feat-other')).id;
  senderId = (await makeSender()).id;
});

afterAll(async () => {
  for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
  await closeQueues(queues);
  await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await prisma.sender.delete({ where: { id: senderId } });
  await conn.quit();
  await redis.quit();
  await prisma.$disconnect();
});

describe('do-not-contact list', () => {
  it('adds valid addresses, reports invalid and already-listed ones, and lists them', async () => {
    const a = `dnc-${tag()}@x.dev`;
    const first = await request(app).post('/api/suppressions').set('Cookie', cookie()).send({ emails: [a.toUpperCase(), 'nope', a] });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ added: 1, alreadyListed: 0, invalid: ['nope'] });
    const again = await request(app).post('/api/suppressions').set('Cookie', cookie()).send({ emails: [a] });
    expect(again.body).toMatchObject({ added: 0, alreadyListed: 1 });

    const list = await request(app).get(`/api/suppressions?q=${a.slice(0, 8)}`).set('Cookie', cookie());
    expect(list.body.items.map((i: { email: string }) => i.email)).toContain(a);
  });

  it('is per user: another user neither sees nor can remove it', async () => {
    const a = `private-${tag()}@x.dev`;
    await request(app).post('/api/suppressions').set('Cookie', cookie()).send({ emails: [a] });
    const theirs = await request(app).get(`/api/suppressions?q=${a}`).set('Cookie', cookieFor(otherId));
    expect(theirs.body.total).toBe(0);
    const id = (await prisma.suppressedEmail.findFirstOrThrow({ where: { userId, email: a } })).id;
    expect((await request(app).delete(`/api/suppressions/${id}`).set('Cookie', cookieFor(otherId))).status).toBe(404);
    expect((await request(app).delete(`/api/suppressions/${id}`).set('Cookie', cookie())).status).toBe(204);
  });

  it('a campaign skips listed leads, reports them, and never queues them', async () => {
    const [ok, blocked] = [`ok-${tag()}@x.dev`, `blocked-${tag()}@x.dev`];
    await prisma.suppressedEmail.create({ data: { userId, email: blocked } });
    const c = await campaign([ok, blocked.toUpperCase()]);
    expect(c).toMatchObject({ accepted: 1, suppressed: 1, recentlyEmailed: 0 });
    expect(c.rows.map((r) => r.toEmail)).toEqual([ok]);
    expect(await prisma.email.count({ where: { userId, toEmail: blocked } })).toBe(0);
  });

  it('fails clearly when every lead is skipped', async () => {
    const e = `all-${tag()}@x.dev`;
    await prisma.suppressedEmail.create({ data: { userId, email: e } });
    await expect(campaign([e])).rejects.toMatchObject({ status: 400 });
  });
});

describe('"recently emailed" guard', () => {
  it('skips people this user already emailed/scheduled within N days, but not failed or cancelled ones', async () => {
    const [sent, failed, fresh] = [`s-${tag()}@x.dev`, `f-${tag()}@x.dev`, `n-${tag()}@x.dev`];
    const first = await campaign([sent, failed]);
    await prisma.email.update({ where: { id: first.rows[0]!.id }, data: { status: 'SENT', sentAt: new Date() } });
    await prisma.email.update({ where: { id: first.rows[1]!.id }, data: { status: 'FAILED', failedAt: new Date() } });

    const off = await campaign([sent], { skipRecentDays: 0 });
    expect(off.accepted).toBe(1); // guard off → allowed

    const on = await campaign([sent, failed, fresh], { skipRecentDays: 30 });
    expect(on).toMatchObject({ accepted: 2, recentlyEmailed: 1 });
    expect(on.rows.map((r) => r.toEmail).sort()).toEqual([failed, fresh].sort());
  });

  it('another user’s history does not count', async () => {
    const e = `shared-${tag()}@x.dev`;
    const camp = await prisma.campaign.create({
      data: { userId: otherId, subject: 's', body: 'b', startAt: new Date(), delayBetweenMs: 0, hourlyLimit: 5, totalRecipients: 1 },
    });
    await prisma.email.create({
      data: { id: randomUUID(), campaignId: camp.id, userId: otherId, senderId, toEmail: e, subject: 's', body: 'b', sequence: 0, scheduledAt: new Date(), nextAttemptAt: new Date(), status: 'SENT', sentAt: new Date() },
    });
    expect((await campaign([e], { skipRecentDays: 30 })).accepted).toBe(1);
  });
});

describe('preflight report + forecast', () => {
  const body = (emails: string[], extra: Record<string, unknown> = {}) => ({
    emails,
    startAt: new Date(Date.now() + 60_000).toISOString(),
    delayBetweenSeconds: 0,
    hourlyLimit: 100,
    senderIds: [senderId],
    ...extra,
  });

  it('counts valid / invalid / duplicate / suppressed / recent, and forecasts the rest', async () => {
    const [a, b, c] = [`p1-${tag()}@x.dev`, `p2-${tag()}@x.dev`, `p3-${tag()}@x.dev`];
    await prisma.suppressedEmail.create({ data: { userId, email: b } });
    const res = await request(app).post('/api/campaigns/preflight').set('Cookie', cookie()).send(body([a, b, c, a.toUpperCase(), 'bad']));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: 3, invalid: 1, duplicates: 1, suppressed: 1, recentlyEmailed: 0, sendable: 2 });
    expect(res.body.forecast.windows.reduce((s: number, w: { count: number }) => s + w.count, 0)).toBe(2);
    expect(res.body.forecast.finishAt).toBeTruthy();
  });

  it('is read-only: nothing is created or queued', async () => {
    const before = await prisma.campaign.count({ where: { userId } });
    await request(app).post('/api/campaigns/preflight').set('Cookie', cookie()).send(body([`ro-${tag()}@x.dev`]));
    expect(await prisma.campaign.count({ where: { userId } })).toBe(before);
  });

  it('a limited campaign forecasts several windows', async () => {
    const emails = Array.from({ length: 25 }, (_, i) => `many-${tag()}-${i}@x.dev`);
    const res = await request(app).post('/api/campaigns/preflight').set('Cookie', cookie()).send(body(emails, { hourlyLimit: 10 }));
    expect(res.body.forecast.windows.map((w: { count: number }) => w.count)).toEqual([10, 10, 5]);
    expect(res.body.forecast.windows[0].limited).toBe(true);
  });

  it('validates input and requires auth', async () => {
    expect((await request(app).post('/api/campaigns/preflight').set('Cookie', cookie()).send({})).status).toBe(400);
    expect((await request(app).post('/api/campaigns/preflight').send(body(['a@x.dev']))).status).toBe(401);
  });
});

describe('business-hours sending window', () => {
  const win = (over: Partial<SendWindow> = {}): SendWindow => ({ startHour: 9, endHour: 17, timezone: 'UTC', weekdaysOnly: false, ...over });
  const at22UtcTomorrow = () => {
    const d = new Date(Date.now() + DAY);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22, 0);
  };

  it('a campaign started outside the window is scheduled for the next opening, spacing preserved', async () => {
    const start = at22UtcTomorrow();
    const w = win();
    const c = await campaign([`w1-${tag()}@x.dev`, `w2-${tag()}@x.dev`, `w3-${tag()}@x.dev`], {
      sendWindow: w,
      delayBetweenSeconds: 60,
    }, start - Date.now());
    const opens = nextSendWindowStart(start, w);
    expect(new Date(opens).getUTCHours()).toBe(9);
    expect(c.rows.map((r) => r.scheduledAt.getTime())).toEqual([opens, opens + 60_000, opens + 120_000]);
    expect(c.firstSendAt).toBe(new Date(opens).toISOString());
    for (const r of c.rows) expect(await state(r.id)).toBe('delayed');
  });

  it('weekdays-only never schedules on a weekend', async () => {
    const c = await campaign(Array.from({ length: 6 }, () => `wk-${tag()}@x.dev`), { sendWindow: win({ weekdaysOnly: true }), delayBetweenSeconds: 3 * 3600 }, 5 * DAY);
    for (const r of c.rows) {
      expect(isInSendWindow(r.scheduledAt.getTime(), win({ weekdaysOnly: true }))).toBe(true);
      expect([0, 6]).not.toContain(r.scheduledAt.getUTCDay());
    }
  });

  it('the worker holds a deferred email that wakes outside business hours — no send, no quota used', async () => {
    const h = new Date().getUTCHours();
    const startHour = (h + 3) % 24;
    const closed = win({ startHour, endHour: startHour + 1 });
    expect(isInSendWindow(Date.now(), closed)).toBe(false);

    const c = await campaign([`hold-${tag()}@x.dev`], { sendWindow: closed }, 0);
    const id = c.rows[0]!.id;
    const send = vi.fn<SendFn>();
    const limiter = new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: DAY, minDelayMs: 0 });
    const acquire = vi.spyOn(limiter, 'acquire');
    const processor = createEmailProcessor({
      prisma, limiter, send, logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000 },
      onRateLimited: async () => {},
    });
    const job = { id, data: { emailId: id }, opts: {}, attemptsMade: 0, updateData: vi.fn(), moveToDelayed: vi.fn(async () => {}) } as unknown as Job<EmailJobData>;
    await expect(processor(job, 't')).rejects.toThrow(); // DelayedError
    expect(send).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    const opens = nextSendWindowStart(Date.now(), closed);
    expect((job.moveToDelayed as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(opens);
    expect((await prisma.email.findUniqueOrThrow({ where: { id } })).nextAttemptAt.getTime()).toBe(opens);
  });

  it('rejects an invalid window', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({
      subject: 's', body: 'b', leads: [{ email: 'a@x.dev' }], startAt: new Date(Date.now() + 1e5).toISOString(),
      delayBetweenSeconds: 0, hourlyLimit: 5, sendWindow: { startHour: 17, endHour: 9, timezone: 'UTC' },
    });
    expect(res.status).toBe(400);
  });
});

describe('bulk retry failed', () => {
  it('re-queues every failed email of a campaign, only for the owner, and is a no-op the second time', async () => {
    const c = await campaign([`r1-${tag()}@x.dev`, `r2-${tag()}@x.dev`, `r3-${tag()}@x.dev`]);
    for (const r of c.rows.slice(0, 2)) {
      await prisma.email.update({ where: { id: r.id }, data: { status: 'FAILED', failedAt: new Date(), lastError: 'SMTP 550' } });
      await queues.email.remove(r.id);
    }
    expect((await request(app).post(`/api/campaigns/${c.campaignId}/retry-failed`).set('Cookie', cookieFor(otherId))).status).toBe(404);

    const res = await request(app).post(`/api/campaigns/${c.campaignId}/retry-failed`).set('Cookie', cookie());
    expect(res.body).toEqual({ retried: 2 });
    const rows = await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['SCHEDULED', 'SCHEDULED', 'SCHEDULED']);
    expect(rows[0]).toMatchObject({ lastError: null, failedAt: null });
    expect(await state(rows[0]!.id)).toBe('waiting'); // due now
    const events = await prisma.emailEvent.findMany({ where: { emailId: rows[0]!.id }, orderBy: { at: 'asc' } });
    expect(events.map((e) => e.type)).toEqual(['SCHEDULED', 'RETRIED']);

    expect((await request(app).post(`/api/campaigns/${c.campaignId}/retry-failed`).set('Cookie', cookie())).body).toEqual({ retried: 0 });
  });

  it('refuses on a cancelled campaign and does not enqueue for a paused one', async () => {
    const paused = await campaign([`pz-${tag()}@x.dev`]);
    await prisma.email.update({ where: { id: paused.rows[0]!.id }, data: { status: 'FAILED', failedAt: new Date() } });
    await queues.email.remove(paused.rows[0]!.id);
    await prisma.campaign.update({ where: { id: paused.campaignId }, data: { status: 'PAUSED' } });
    expect((await request(app).post(`/api/campaigns/${paused.campaignId}/retry-failed`).set('Cookie', cookie())).body).toEqual({ retried: 1 });
    expect(await state(paused.rows[0]!.id)).toBe('unknown'); // resume will enqueue it

    await prisma.campaign.update({ where: { id: paused.campaignId }, data: { status: 'CANCELLED' } });
    expect((await request(app).post(`/api/campaigns/${paused.campaignId}/retry-failed`).set('Cookie', cookie())).status).toBe(409);
  });
});

describe('CSV export', () => {
  const parse = (csv: string) => csv.replace(/^\uFEFF/, '').trim().split('\r\n');

  it('streams a filtered CSV with a header, safe cells, and a download filename', async () => {
    const evil = `=HYPERLINK("http://evil.example","x")`;
    const c = await campaign([`e1-${tag()}@x.dev`, `e2-${tag()}@x.dev`, `e3-${tag()}@x.dev`]);
    await prisma.email.update({ where: { id: c.rows[0]!.id }, data: { status: 'SENT', sentAt: new Date(), subject: evil } });
    await prisma.email.update({ where: { id: c.rows[1]!.id }, data: { status: 'FAILED', failedAt: new Date(), lastError: 'boom, "quoted"' } });

    const res = await request(app).get(`/api/emails/export?campaignId=${c.campaignId}&tab=sent`).set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="emails-.*\.csv"/);
    const lines = parse(res.text);
    expect(lines[0]).toBe('to,name,subject,status,sender,scheduled_at,next_attempt_at,sent_at,failed_at,attempts,error,preview_url,campaign_id');
    expect(lines).toHaveLength(3); // header + SENT + FAILED (tab=sent), the scheduled one is excluded
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`); // formula neutralised + quotes escaped
    expect(res.text).toContain('"boom, ""quoted"""');
  });

  it('status filter and campaign filter narrow the rows; all statuses when unfiltered', async () => {
    const c = await campaign([`f1-${tag()}@x.dev`, `f2-${tag()}@x.dev`]);
    await prisma.email.update({ where: { id: c.rows[0]!.id }, data: { status: 'FAILED', failedAt: new Date() } });
    const failed = await request(app).get(`/api/emails/export?campaignId=${c.campaignId}&status=FAILED`).set('Cookie', cookie());
    expect(parse(failed.text)).toHaveLength(2);
    const all = await request(app).get(`/api/emails/export?campaignId=${c.campaignId}`).set('Cookie', cookie());
    expect(parse(all.text)).toHaveLength(3);
  });

  it('only ever exports the caller’s own emails; requires auth; validates filters', async () => {
    const c = await campaign([`mine-${tag()}@x.dev`]);
    const theirs = await request(app).get(`/api/emails/export?campaignId=${c.campaignId}`).set('Cookie', cookieFor(otherId));
    expect(parse(theirs.text)).toHaveLength(1); // header only
    expect((await request(app).get('/api/emails/export')).status).toBe(401);
    expect((await request(app).get('/api/emails/export?status=NOPE').set('Cookie', cookie())).status).toBe(400);
  });
});

describe('test send', () => {
  it('renders merge tags for the sample lead, prefixes [TEST], sends to the sender’s own inbox, returns the preview link', async () => {
    sendMock.mockClear();
    const res = await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({
      subject: 'Hello {{name}} from {{company}}',
      body: 'Hi {{name}}, about {{company}}',
      senderId,
      sample: { email: 'maya@northwind.example', name: 'Maya', vars: { company: 'Northwind' } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: '[TEST] Hello Maya from Northwind', previewUrl: 'https://ethereal.email/message/abc' });
    const [sender, email] = sendMock.mock.calls[0]!;
    expect(sender.id).toBe(senderId);
    expect(email).toMatchObject({ to: sender.email, subject: '[TEST] Hello Maya from Northwind', body: 'Hi Maya, about Northwind' });
  });

  it('honours the sender’s minimum delay: an immediate second test send is refused with a wait time', async () => {
    const min = Number(process.env.MIN_DELAY_BETWEEN_EMAILS_MS ?? 2000);
    if (min <= 0) return;
    const again = await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({ subject: 's', body: 'b', senderId });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('RATE_LIMITED');
  });

  it('reports SMTP trouble as 503 and validates input', async () => {
    await new Promise((r) => setTimeout(r, 2100));
    sendMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({ subject: 's', body: 'b', senderId });
    expect(res.status).toBe(503);
    expect((await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({})).status).toBe(400);
    expect((await request(app).post('/api/campaigns/test-send').send({ subject: 's', body: 'b' })).status).toBe(401);
  });
});

describe('spintax and jitter through the real scheduler', () => {
  it('each stored email gets its recipient’s variant, merge tags filled after spinning', async () => {
    const leads = Array.from({ length: 30 }, (_, i) => `spin${i}-${tag()}@x.dev`);
    const c = await campaign(leads, { subject: '{Hi|Hello|Hey} {{name}}', body: '{Quick|Short} note for {{email}}' });
    const subjects = new Set(c.rows.map((r) => r.subject.split(' ')[0]));
    expect(subjects).toEqual(new Set(['Hi', 'Hello', 'Hey']));
    for (const r of c.rows) {
      expect(r.subject).toBe(renderTemplate(spin('{Hi|Hello|Hey} {{name}}', r.toEmail), { name: '', email: r.toEmail }));
      expect(r.body).toMatch(new RegExp(`^(Quick|Short) note for ${r.toEmail.replace(/[.+]/g, '\\$&')}$`));
      expect(r.subject).not.toContain('{');
    }
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } })).jitterPercent).toBe(0);
  });

  it('jitter varies the stored schedule and is recorded on the campaign', async () => {
    const leads = Array.from({ length: 20 }, (_, i) => `jit${i}-${tag()}@x.dev`);
    const c = await campaign(leads, { delayBetweenSeconds: 60, jitterPercent: 30 });
    const times = c.rows.map((r) => r.scheduledAt.getTime());
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(new Set(gaps).size).toBeGreaterThan(10);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(42_000);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(78_000);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.campaignId } })).jitterPercent).toBe(30);
  });

  it('the API refuses malformed spintax on schedule and on test send', async () => {
    const res = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({
      subject: '{Hi|Hello {{name}}', body: 'b', leads: [{ email: 'a@x.dev' }], startAt: new Date(Date.now() + 1e5).toISOString(), delayBetweenSeconds: 0, hourlyLimit: 5,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('never closed');
    const t = await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({ subject: '{name}', body: 'b', senderId });
    expect(t.status).toBe(400);
  });

  it('test send uses the same variant the previewed lead will receive', async () => {
    await new Promise((r) => setTimeout(r, 2100)); // sender minimum delay after earlier test sends
    sendMock.mockClear();
    const lead = 'variant-check@x.dev';
    const res = await request(app).post('/api/campaigns/test-send').set('Cookie', cookie()).send({
      subject: '{Hi|Hello|Hey} there', body: '{A|B|C}', senderId, sample: { email: lead },
    });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe(`[TEST] ${spin('{Hi|Hello|Hey} there', lead)}`);
    expect(sendMock.mock.calls[0]![1].body).toBe(spin('{A|B|C}', lead));
  });
});
