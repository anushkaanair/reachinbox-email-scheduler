import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';
import { redis } from '../src/lib/redis.js';
import { SESSION_COOKIE, setSession } from '../src/modules/auth/session.js';

const app = createApp();

/** Mint a real session cookie via the production code path. */
function cookieFor(userId: string): string {
  let header = '';
  setSession({ cookie: (name: string, value: string) => (header = `${name}=${value}`) } as never, userId);
  return header;
}

describe('crypto', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('xoxb-secret');
    expect(a).not.toBe(encrypt('xoxb-secret'));
    expect(decrypt(a)).toBe('xoxb-secret');
  });

  it('rejects tampered ciphertext', () => {
    const buf = Buffer.from(encrypt('hello'), 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decrypt(buf.toString('base64'))).toThrow();
  });
});

describe('http', () => {
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    const mk = (n: string) =>
      prisma.user.create({
        data: { googleId: `test-${n}-${Date.now()}`, email: `${n}-${Date.now()}@test.dev`, name: `User ${n}` },
      });
    userA = (await mk('a')).id;
    userB = (await mk('b')).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.$disconnect();
    await redis.quit();
  });

  it('GET /healthz reports db and redis', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ db: true, redis: true });
  });

  it.each(['/api/auth/me', '/api/emails', '/api/emails/counts', '/api/senders'])('%s requires auth', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged session cookie', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns the signed-in user', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieFor(userA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: userA, name: 'User a', slackConnected: false });
  });

  it('GET /api/emails validates the tab and returns an empty page', async () => {
    const bad = await request(app).get('/api/emails?status=nope').set('Cookie', cookieFor(userA));
    expect(bad.status).toBe(400);
    const ok = await request(app).get('/api/emails?status=sent').set('Cookie', cookieFor(userA));
    expect(ok.body).toEqual({ items: [], nextCursor: null });
  });

  it('isolates tenants: user B never sees user A emails', async () => {
    const sender = await prisma.sender.create({
      data: { email: `s-${Date.now()}@ethereal.email`, displayName: 'S', smtpUser: 'u', smtpPassEnc: encrypt('p') },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId: userA, subject: 'Hi', body: 'B', startAt: new Date(), delayBetweenMs: 0,
        hourlyLimit: 10, totalRecipients: 1,
      },
    });
    await prisma.email.create({
      data: {
        campaignId: campaign.id, userId: userA, senderId: sender.id, toEmail: 'lead@x.dev',
        subject: 'Hi', body: 'B', sequence: 0, scheduledAt: new Date(), nextAttemptAt: new Date(),
      },
    });

    const a = await request(app).get('/api/emails?status=scheduled').set('Cookie', cookieFor(userA));
    const b = await request(app).get('/api/emails?status=scheduled').set('Cookie', cookieFor(userB));
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0]).toMatchObject({ toEmail: 'lead@x.dev', status: 'SCHEDULED' });
    expect(b.body.items).toHaveLength(0);

    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.sender.delete({ where: { id: sender.id } });
  });

  it('GET /api/senders lists active senders with limit and usage', async () => {
    const res = await request(app).get('/api/senders').set('Cookie', cookieFor(userA));
    expect(res.status).toBe(200);
    for (const s of res.body) {
      expect(s).toMatchObject({ isActive: true });
      expect(typeof s.hourlyLimit).toBe('number');
      expect(typeof s.usedThisWindow).toBe('number');
    }
  });

  it('POST /api/auth/logout clears the cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('GET /api/auth/google without credentials bounces back to the login page', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/login\?error=not_configured$|accounts\.google\.com/);
  });
});
