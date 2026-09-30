import { randomUUID } from 'node:crypto';
import type { Profile } from 'passport-google-oauth20';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { upsertFromProfile } from '../src/modules/auth/google.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { testPrefix } from './helpers.js';

describe('password hashing', () => {
  it('verifies the right password only, with a fresh salt each time', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });
  it('treats equivalent unicode as equal, and rejects malformed or tampered hashes', async () => {
    const h = await hashPassword('café-password');
    expect(await verifyPassword('café-password', h)).toBe(true); // NFKC
    const parts = h.split('$');
    const flipped = Buffer.from(parts[5]!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff; // change a real byte, not base64 padding
    const tampered = [...parts.slice(0, 5), flipped.toString('base64')].join('$');
    for (const bad of ['', 'nope', 'scrypt$1$2', 'bcrypt$x$y$z$a$b', tampered]) expect(await verifyPassword('caf\u00e9-password', bad), bad).toBe(false);
  });
});

describe('email + password sign-in', () => {
  const conn = createRedis('test-pwauth');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  const made: string[] = [];
  const addr = () => `pw-${randomUUID().slice(0, 8)}@test.dev`;
  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('ri_session='));

  // The limiter is tested on purpose in one case below; every other case starts with clean counters.
  beforeEach(async () => {
    const keys = await redis.keys('reqlimit:pw-*');
    if (keys.length) await redis.del(...keys);
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: made.map((e) => e.toLowerCase()) } } });
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await conn.quit();
  });
  const signup = async (email = addr(), password = 'a-decent-password', name?: string) => {
    made.push(email);
    return { email, password, res: await request(app).post('/api/auth/signup').send({ email, password, name }) };
  };

  it('signs up, stores only a hash, and the session works', async () => {
    const { email, password, res } = await signup(addr(), 'a-decent-password', 'Ada Lovelace');
    expect(res.status).toBe(201);
    const cookie = cookieOf(res)!;
    expect(cookie).toContain('HttpOnly');
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row).toMatchObject({ googleId: null, name: 'Ada Lovelace' });
    expect(row.passwordHash).toMatch(/^scrypt\$/);
    expect(row.passwordHash).not.toContain(password);
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]!);
    expect(me.body).toMatchObject({ email, name: 'Ada Lovelace', avatarUrl: null });
  });

  it('defaults the name from the address and lowercases the email', async () => {
    const email = `Mixed.Case-${randomUUID().slice(0, 6)}@Test.dev`;
    const { res } = await signup(email);
    expect(res.status).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    expect(row.name).toBe(email.toLowerCase().split('@')[0]);
  });

  it('validates input', async () => {
    expect((await signup(addr(), 'short')).res.status).toBe(400);
    expect((await signup('not-an-email')).res.status).toBe(400);
    expect((await signup(addr(), 'x'.repeat(129))).res.status).toBe(400);
    expect((await request(app).post('/api/auth/signup').send({})).status).toBe(400);
  });

  it('refuses a second account for the same address, in any letter case', async () => {
    const { email } = await signup();
    const again = await request(app).post('/api/auth/signup').send({ email: email.toUpperCase(), password: 'another-password' });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/already exists/);
  });

  it('logs in with the right password, in any email case', async () => {
    const { email, password } = await signup();
    const res = await request(app).post('/api/auth/login').send({ email: email.toUpperCase(), password });
    expect(res.status).toBe(204);
    const cookie = cookieOf(res)!;
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]!)).status).toBe(200);
  });

  it('fails the same way for a wrong password, an unknown email, and a Google-only account', async () => {
    const { email } = await signup();
    const googleOnly = `g-${randomUUID().slice(0, 8)}@test.dev`;
    made.push(googleOnly);
    await prisma.user.create({ data: { email: googleOnly, name: 'G', googleId: `g-${randomUUID()}` } });
    const attempts = await Promise.all([
      request(app).post('/api/auth/login').send({ email, password: 'wrong-password-1' }),
      request(app).post('/api/auth/login').send({ email: addr(), password: 'whatever-it-is' }),
      request(app).post('/api/auth/login').send({ email: googleOnly, password: 'whatever-it-is' }),
    ]);
    for (const r of attempts) {
      expect(r.status).toBe(401);
      expect(r.body.error.message).toBe('Invalid email or password');
      expect(cookieOf(r)).toBeUndefined();
    }
    expect((await request(app).post('/api/auth/login').send({ email })).status).toBe(400);
  });

  it('throttles repeated guesses against one account', async () => {
    const { email } = await signup();
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await request(app).post('/api/auth/login').send({ email, password: `guess-number-${i}` })).status);
    expect(codes.slice(0, 8).every((c) => c === 401)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    // Even the right password is refused while the account is throttled.
    expect((await request(app).post('/api/auth/login').send({ email, password: 'a-decent-password' })).status).toBe(429);
  });

  it('Google sign-in links to a password account and removes the password (no pre-hijack)', async () => {
    const { email, password } = await signup();
    const before = await prisma.user.findUniqueOrThrow({ where: { email } });
    const profile = { id: `gid-${randomUUID()}`, displayName: 'Real Owner', emails: [{ value: email, verified: true }], photos: [{ value: 'https://x.test/a.png' }] } as unknown as Profile;
    const linked = await upsertFromProfile(profile);
    expect(linked.id).toBe(before.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: before.id } });
    expect(after).toMatchObject({ googleId: profile.id, passwordHash: null, name: 'Real Owner' });
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(401); // the pre-registered password no longer works
    expect((await upsertFromProfile(profile)).id).toBe(before.id); // and Google keeps working
  });

  it('Google creates a brand-new user when the address is unused', async () => {
    const email = addr();
    made.push(email);
    const user = await upsertFromProfile({ id: `gid-${randomUUID()}`, displayName: 'New Person', emails: [{ value: email, verified: true }], photos: [] } as unknown as Profile);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ email, name: 'New Person', passwordHash: null });
  });
});
