import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { SlackService } from '../src/modules/slack/slackService.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeUser, silentLogger, testPrefix } from './helpers.js';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secretsecret';
const SECRET = 'test-jwt-secret-test-jwt-secret-test-jwt';

/** Programmable stand-in for Slack's HTTP API; records every call. */
const slackApi = vi.fn(async (url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  const u = String(url);
  if (u.endsWith('/oauth.v2.access')) {
    return Response.json({
      ok: true,
      access_token: 'xoxb-bot-token',
      team: { id: 'T000', name: 'Acme Workspace' },
      incoming_webhook: { url: WEBHOOK, channel: '#alerts', channel_id: 'C000' },
    });
  }
  if (u.endsWith('/auth.revoke')) return Response.json({ ok: true, revoked: true });
  if (u === WEBHOOK) return new Response('ok');
  return new Response('not found', { status: 404 });
});

const cfg = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://tunnel.example/api/slack/oauth/callback', webUrl: 'http://localhost:5173', jwtSecret: SECRET };
const slack = new SlackService(prisma, cfg, silentLogger, slackApi as typeof fetch);
const conn = createRedis('test-slack');
const queues = createQueues(conn, testPrefix());
const app = createApp({ queues, slack });

let userId: string;
const cookie = () => {
  let h = '';
  setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
  return h;
};
const stateFor = (id: string) => new URL(slack.authorizeUrl(id)).searchParams.get('state')!;
const notice = () => ({
  userId,
  senderId: 's1',
  senderEmail: 'sender@ethereal.email',
  scope: 'sender' as const,
  limit: 50,
  windowStart: new Date().toISOString(),
  retryAt: new Date(Date.now() + 3_600_000).toISOString(),
});

beforeAll(async () => {
  userId = (await makeUser('slack')).id;
});
beforeEach(() => slackApi.mockClear());
afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } });
  await closeQueues(queues);
  await conn.quit();
  await redis.quit();
  await prisma.$disconnect();
});

describe('Slack integration', () => {
  it('not connected: rate-limit notifications are skipped without calling Slack or throwing', async () => {
    await expect(slack.notifyRateLimit(notice())).resolves.toBe('skipped_not_connected');
    expect(slackApi).not.toHaveBeenCalled();
    const status = await request(app).get('/api/slack').set('Cookie', cookie());
    expect(status.body).toMatchObject({ configured: true, connected: false });
  });

  it('connect redirects to Slack’s real authorize URL with scopes and a signed state', async () => {
    const res = await request(app).get('/api/slack/connect').set('Cookie', cookie());
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location!);
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('scope')).toBe('incoming-webhook,chat:write');
    expect(slack.verifyState(url.searchParams.get('state')!)).toBe(userId);
  });

  it('rejects a forged or missing state', async () => {
    const res = await request(app).get('/api/slack/oauth/callback?code=abc&state=forged');
    expect(res.headers.location).toBe('http://localhost:5173/settings?slack=invalid_state');
    expect(slackApi).not.toHaveBeenCalled();
  });

  it('handles the user cancelling on Slack', async () => {
    const res = await request(app).get('/api/slack/oauth/callback?error=access_denied');
    expect(res.headers.location).toBe('http://localhost:5173/settings?slack=denied');
  });

  it('callback exchanges the code and stores the webhook encrypted', async () => {
    const res = await request(app).get(`/api/slack/oauth/callback?code=the-code&state=${stateFor(userId)}`);
    expect(res.headers.location).toBe('http://localhost:5173/settings?slack=connected');
    const body = String(slackApi.mock.calls[0]![1]!.body);
    expect(body).toContain('code=the-code');
    expect(body).toContain('client_secret=csecret');

    const row = await prisma.slackConnection.findUniqueOrThrow({ where: { userId } });
    expect(row).toMatchObject({ teamName: 'Acme Workspace', channelName: '#alerts', isValid: true });
    expect(row.webhookUrlEnc).not.toContain('hooks.slack.com'); // encrypted at rest
    expect(row.botTokenEnc).not.toContain('xoxb');

    const status = await request(app).get('/api/slack').set('Cookie', cookie());
    expect(status.body).toMatchObject({ connected: true, valid: true, teamName: 'Acme Workspace', channelName: '#alerts' });
  });

  it('connected: a rate-limit hit posts a Block Kit message to the webhook immediately', async () => {
    await expect(slack.notifyRateLimit(notice())).resolves.toBe('sent');
    const [url, init] = slackApi.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    const msg = JSON.parse(String(init!.body));
    expect(msg.text).toContain('sender@ethereal.email');
    expect(msg.blocks[0].text.text).toContain('Hourly sending limit reached');
  });

  it('POST /api/slack/test sends a test message', async () => {
    const res = await request(app).post('/api/slack/test').set('Cookie', cookie());
    expect(res.status).toBe(204);
    expect(slackApi.mock.calls[0]![0]).toBe(WEBHOOK);
  });

  it('transient Slack errors throw (so the queue retries); dead webhooks are marked invalid', async () => {
    slackApi.mockResolvedValueOnce(new Response('rate_limited', { status: 429 }));
    await expect(slack.notifyRateLimit(notice())).rejects.toThrow('429');
    slackApi.mockResolvedValueOnce(new Response('no_service', { status: 404 }));
    await expect(slack.notifyRateLimit(notice())).resolves.toBe('skipped_invalid');
    const status = await request(app).get('/api/slack').set('Cookie', cookie());
    expect(status.body).toMatchObject({ connected: true, valid: false });
    expect((await request(app).post('/api/slack/test').set('Cookie', cookie())).status).toBe(409);
  });

  it('reconnecting restores a working connection without any restart', async () => {
    await request(app).get(`/api/slack/oauth/callback?code=again&state=${stateFor(userId)}`);
    await expect(slack.notifyRateLimit(notice())).resolves.toBe('sent');
  });

  it('disconnect revokes the token and deletes the connection; later hits are skipped', async () => {
    const res = await request(app).delete('/api/slack').set('Cookie', cookie());
    expect(res.status).toBe(204);
    expect(String(slackApi.mock.calls[0]![0])).toContain('auth.revoke');
    expect(await prisma.slackConnection.count({ where: { userId } })).toBe(0);
    await expect(slack.notifyRateLimit(notice())).resolves.toBe('skipped_not_connected');
  });

  it('when the server has no Slack app configured, connect bounces back with a clear reason', async () => {
    const unconfigured = new SlackService(prisma, { webUrl: cfg.webUrl, jwtSecret: SECRET }, silentLogger, slackApi as typeof fetch);
    const a = createApp({ queues, slack: unconfigured });
    const res = await request(a).get('/api/slack/connect').set('Cookie', cookie());
    expect(res.headers.location).toBe('http://localhost:5173/settings?slack=not_configured');
  });
});
