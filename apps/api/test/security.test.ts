import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { redactUrl, requestLogSerializers } from '../src/lib/httpSecurity.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { SESSION_COOKIE, setSession } from '../src/modules/auth/session.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeUser, testPrefix } from './helpers.js';

const conn = createRedis('test-sec');
const queues = createQueues(conn, testPrefix());
const app = createApp({ queues });
let user: { id: string; email: string };
let admin: { id: string; email: string };

const cookieFor = (id: string) => {
  let h = '';
  setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
  return h;
};

beforeAll(async () => {
  user = await makeUser('sec');
  admin = await makeUser('boss');
});
afterAll(async () => {
  env.adminEmails.length = 0;
  await prisma.user.deleteMany({ where: { id: { in: [user.id, admin.id] } } });
  await closeQueues(queues);
  await conn.quit();
  await redis.quit();
  await prisma.$disconnect();
});

describe('security hardening', () => {
  it('S1: OAuth codes, state and tokens are redacted from logged URLs', () => {
    expect(redactUrl('/api/slack/oauth/callback?code=abc123&state=eyJhbGc.x.y')).toBe(
      '/api/slack/oauth/callback?code=[redacted]&state=[redacted]',
    );
    expect(redactUrl('/api/auth/google/callback?state=s&code=4%2F0A&scope=email')).toBe(
      '/api/auth/google/callback?state=[redacted]&code=[redacted]&scope=email',
    );
    expect(redactUrl('/api/emails?status=sent')).toBe('/api/emails?status=sent');
  });

  it('S1b: request logs never include headers (Cookie / Set-Cookie carry the session token)', () => {
    const res = { statusCode: 200, getHeaders: () => ({ 'set-cookie': 'ri_session=eyJsecret' }), headers: { 'set-cookie': 'x' } };
    expect(requestLogSerializers.res(res)).toEqual({ statusCode: 200 });
    const req = { id: 1, method: 'GET', url: '/x?code=abc', headers: { cookie: 'ri_session=eyJsecret' } };
    expect(JSON.stringify(requestLogSerializers.req(req))).not.toMatch(/eyJsecret|abc/);
  });

  it('S2: an unsigned ("alg: none") session token is rejected', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: user.id })}.`;
    const res = await request(app).get('/api/auth/me').set('Cookie', `${SESSION_COOKIE}=${forged}`);
    expect(res.status).toBe(401);
  });

  it('S3: with ADMIN_EMAILS set, only admins can open Bull Board', async () => {
    env.adminEmails.push(admin.email.toLowerCase());
    expect((await request(app).get('/admin/queues').set('Cookie', cookieFor(user.id))).status).toBe(403);
    expect((await request(app).get('/admin/queues').set('Cookie', cookieFor(admin.id))).status).toBe(200);
    env.adminEmails.length = 0;
    expect((await request(app).get('/admin/queues').set('Cookie', cookieFor(user.id))).status).toBe(200);
  });

  it('S4: campaign creation is throttled per user with 429 + Retry-After', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      // Invalid body → cheap 400s, but each still counts against the limit.
      statuses.push((await request(app).post('/api/campaigns').set('Cookie', cookieFor(user.id)).send({})).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true);
    const last = await request(app).post('/api/campaigns').set('Cookie', cookieFor(user.id)).send({});
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    // Another user is unaffected.
    expect((await request(app).post('/api/campaigns').set('Cookie', cookieFor(admin.id)).send({})).status).toBe(400);
  });

  it('session cookie is httpOnly + SameSite=Lax', () => {
    let opts: Record<string, unknown> = {};
    setSession({ cookie: (_n: string, _v: string, o: Record<string, unknown>) => (opts = o) } as never, user.id);
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
  });

  it('sends security headers', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
