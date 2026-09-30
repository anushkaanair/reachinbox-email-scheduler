import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChecklist, checklistProgress, OnboardingStatusSchema, recommendSetup, type OnboardingProfile } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis } from '../src/lib/redis.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { closeQueues, createQueues } from '../src/queues/queues.js';
import { makeSender, makeUser, testPrefix } from './helpers.js';

const profile: OnboardingProfile = { role: 'founder', goal: 'meetings', stage: 'new', volume: 'starter' };

describe('setup recommendation and checklist (shared)', () => {
  it('scales mailboxes with volume and keeps the per-mailbox pace conservative', () => {
    const r = (volume: OnboardingProfile['volume'], stage: OnboardingProfile['stage'] = 'scaling') => recommendSetup({ ...profile, volume, stage });
    expect(r('starter').accounts).toBe(7); // 2,000 leads × 3 emails ÷ 880 per mailbox
    expect(r('growing').accounts).toBeGreaterThan(r('starter').accounts);
    expect(r('enterprise').accounts).toBeGreaterThan(r('scaling').accounts);
    expect(r('starter').dailyPerAccount).toBe(40);
    expect(r('starter').monthlyCapacity).toBe(r('starter').accounts * 880);
    expect(r('starter').monthlyCapacity).toBeGreaterThanOrEqual(2000 * 3); // capacity always covers the stated volume
  });
  it('tailors advice to the stage and scale', () => {
    expect(recommendSetup(profile).warmupWeeks).toBe(2);
    expect(recommendSetup({ ...profile, stage: 'scaling' }).warmupWeeks).toBe(1);
    expect(recommendSetup({ ...profile, stage: 'teams' }).tips.join(' ')).toMatch(/Tag accounts/);
    expect(recommendSetup({ ...profile, stage: 'inconsistent' }).tips.join(' ')).toMatch(/SPF, DKIM, DMARC/);
    expect(recommendSetup({ ...profile, volume: 'enterprise' }).tips.join(' ')).toMatch(/several domains/);
    expect(recommendSetup(profile).headline).toBe('Getting started with outbound as a Founder / Small Business');
    expect(recommendSetup({ ...profile, role: 'agency', stage: 'scaling' }).headline).toBe('Scaling outbound as an Agency');
  });
  it('the checklist follows the facts; optional steps do not block completion', () => {
    const none = buildChecklist({ activeSenders: 0, warmingSenders: 0, campaigns: 0, sentEmails: 0, slackConnected: false });
    expect(none.map((s) => s.done)).toEqual([false, false, false, false, false]);
    expect(checklistProgress(none)).toEqual({ done: 0, total: 5, percent: 0, complete: false });
    const core = buildChecklist({ activeSenders: 2, warmingSenders: 0, campaigns: 1, sentEmails: 4, slackConnected: false });
    expect(checklistProgress(core)).toMatchObject({ done: 3, percent: 60, complete: true });
    expect(core.filter((s) => s.optional).map((s) => s.id)).toEqual(['warmup', 'slack']);
  });
});

describe('onboarding API', () => {
  const conn = createRedis('test-onboarding');
  const queues = createQueues(conn, testPrefix());
  const app = createApp({ queues });
  let userId: string;
  const senderIds: string[] = [];

  beforeAll(async () => {
    userId = (await makeUser('onboarding')).id;
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.delete({ where: { id: userId } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });
  const cookie = () => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, userId);
    return h;
  };
  const get = () => request(app).get('/api/onboarding').set('Cookie', cookie());
  const put = (body: object) => request(app).put('/api/onboarding').set('Cookie', cookie()).send(body);

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/onboarding')).status).toBe(401);
    expect((await request(app).put('/api/onboarding').send({ action: 'skip' })).status).toBe(401);
  });

  it('starts with no state and a live checklist', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = OnboardingStatusSchema.parse(res.body);
    expect(body.state).toBeNull();
    expect(body.checklist.map((s) => s.id)).toEqual(['connect', 'warmup', 'campaign', 'send', 'slack']);
    expect(body.checklist.find((s) => s.id === 'campaign')!.done).toBe(false);
  });

  it('stores the answers on complete, and rejects invalid ones', async () => {
    expect((await put({ action: 'complete', profile: { ...profile, role: 'wizard' } })).status).toBe(400);
    expect((await put({ action: 'complete', profile: { role: 'founder' } })).status).toBe(400);
    expect((await put({ action: 'nope' })).status).toBe(400);
    const res = await put({ action: 'complete', profile });
    expect(res.status).toBe(200);
    expect(res.body.state).toMatchObject({ status: 'completed', profile, tour: 'pending', checklistDismissed: false });
    expect((await get()).body.state.profile).toEqual(profile);
  });

  it('tracks the tour and the dismissed checklist', async () => {
    expect((await put({ action: 'tour', status: 'done' })).body.state.tour).toBe('done');
    expect((await put({ action: 'tour', status: 'pending' })).body.state.tour).toBe('pending');
    expect((await put({ action: 'dismiss_checklist', dismissed: true })).body.state.checklistDismissed).toBe(true);
    expect((await put({ action: 'dismiss_checklist', dismissed: false })).body.state.checklistDismissed).toBe(false);
    expect((await put({ action: 'tour', status: 'later' })).status).toBe(400);
  });

  it('skipping never discards answers already given, and a first-time skip is recorded', async () => {
    expect((await put({ action: 'skip' })).body.state).toMatchObject({ status: 'completed', profile });
    const other = await makeUser('onboarding-skip');
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, other.id);
    const res = await request(app).put('/api/onboarding').set('Cookie', h).send({ action: 'skip' });
    expect(res.body.state).toMatchObject({ status: 'skipped', profile: null, tour: 'pending' });
    await prisma.user.delete({ where: { id: other.id } });
  });

  it('the checklist reflects what the account has really done', async () => {
    const s = await makeSender();
    senderIds.push(s.id);
    await prisma.sender.update({ where: { id: s.id }, data: { warmupEnabled: true, warmupStartedAt: new Date() } });
    const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: 3_600_000 };
    const c = await createCampaign(userId, { subject: 's', body: 'b', leads: [{ email: `o-${randomUUID().slice(0, 6)}@x.dev` }], startAt: new Date(Date.now() + 86_400_000).toISOString(), delayBetweenSeconds: 0, hourlyLimit: 100, senderIds: [s.id] }, { prisma, queues, config: cfg });
    let steps = (await get()).body.checklist as { id: string; done: boolean }[];
    const done = (id: string) => steps.find((x) => x.id === id)!.done;
    expect([done('connect'), done('warmup'), done('campaign'), done('send')]).toEqual([true, true, true, false]);

    await prisma.email.updateMany({ where: { campaignId: c.campaignId }, data: { status: 'SENT', sentAt: new Date() } });
    steps = (await get()).body.checklist;
    expect(done('send')).toBe(true);
    expect(done('slack')).toBe(false);
  });
});
