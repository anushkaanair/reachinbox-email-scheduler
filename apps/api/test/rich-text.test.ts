import { randomUUID } from 'node:crypto';
import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { escapeHtml, htmlToText, isHtmlEmpty, textToHtml } from '@ri/shared';
import { createApp } from '../src/app.js';
import { sanitizeBody } from '../src/lib/sanitizeHtml.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { htmlFor, type SendFn } from '../src/mail/transport.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { createEmailProcessor } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

describe('html helpers (shared)', () => {
  it('htmlToText keeps line breaks and bullets and decodes entities', () => {
    expect(htmlToText('<p>Hi <b>Ann</b>,</p><p>Tom &amp; Jerry&nbsp;&lt;3</p>')).toBe('Hi Ann,\n\nTom & Jerry <3');
    expect(htmlToText('<div>one<br>two</div><ul><li>a</li><li>b</li></ul>')).toBe('one\ntwo\n\n• a\n\n• b');
    expect(htmlToText('caf&#233; &#x1F600; &bogus;')).toBe('café 😀 &bogus;');
  });
  it('isHtmlEmpty sees through empty markup', () => {
    expect(isHtmlEmpty('')).toBe(true);
    expect(isHtmlEmpty('<div><br></div><p>&nbsp;</p>')).toBe(true);
    expect(isHtmlEmpty('<div><b>x</b></div>')).toBe(false);
  });
  it('textToHtml escapes and keeps paragraphs', () => {
    expect(textToHtml('a <b> & c\nnext\n\nsecond')).toBe('<p>a &lt;b&gt; &amp; c<br>next</p><p>second</p>');
    expect(escapeHtml(`<a href="x">'&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
  });
});

describe('sanitizeBody (server allowlist)', () => {
  it('keeps what the toolbar makes', () => {
    const html = '<div style="text-align: center;"><b>Bold</b> <i>it</i> <u>un</u> <strike>st</strike> <span style="font-size: large;">big</span></div><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><p style="margin-left: 48px;">in</p>';
    expect(sanitizeBody(html)).toBe(html.replace('text-align: center;', 'text-align:center').replace('font-size: large;', 'font-size:large').replace('margin-left: 48px;', 'margin-left:48px'));
  });
  it('removes scripts, handlers, frames, images, forms and their contents', () => {
    const out = sanitizeBody('<p onclick="x()">hi</p><script>alert(1)</script><style>p{}</style><iframe src="//evil"></iframe><img src=x onerror=alert(1)><form action="//evil"><input></form><object data=x></object>');
    expect(out).toBe('<p>hi</p>');
  });
  it('survives nested and malformed tricks', () => {
    for (const evil of ['<scr<script>ipt>alert(1)</scr</script>ipt>', '<svg/onload=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<a href="  JaVaScRiPt:alert(1)">x</a>', '<a href="data:text/html;base64,AAA">x</a>', '<a href="//evil.test">x</a>', '<b style="background:url(javascript:alert(1))">x</b>']) {
      const out = sanitizeBody(evil);
      expect(out, evil).not.toMatch(/<script|<svg|onload|onerror|javascript:|data:|\/\/evil|url\(/i);
    }
  });
  it('only allows safe links, and adds rel/target', () => {
    expect(sanitizeBody('<a href="https://ok.test/p?q=1">ok</a>')).toBe('<a href="https://ok.test/p?q=1" target="_blank" rel="noopener noreferrer nofollow">ok</a>');
    expect(sanitizeBody('<a href="mailto:a@b.test">m</a>')).toContain('href="mailto:a@b.test"');
    expect(sanitizeBody('<a href="/relative">r</a>')).toBe('<a>r</a>');
  });
  it('drops styles outside the allowed values', () => {
    const out = sanitizeBody('<div style="position:fixed;top:0;text-align:center;font-size:99px;margin-left:500px;color:red">x</div>');
    expect(out).toBe('<div style="text-align:center">x</div>');
    expect(sanitizeBody('<p style="margin-left:0">a</p><p style="margin-left:120px">b</p><p style="margin-left:121px">c</p>')).toBe('<p style="margin-left:0">a</p><p style="margin-left:120px">b</p><p>c</p>');
  });
});

describe('htmlFor (what goes out)', () => {
  it('keeps rich bodies as written and escapes plain ones', () => {
    expect(htmlFor({ body: '<p>Hi</p>', bodyIsHtml: true }, null)).toBe('<div style="font-family:Arial,sans-serif"><p>Hi</p></div>');
    expect(htmlFor({ body: 'a <b> & c\nd', bodyIsHtml: false }, null)).toContain('a &lt;b&gt; &amp; c\nd');
  });
  it('appends an escaped signature to either kind', () => {
    const sig = 'Ann <ann@x.test>\nAcme';
    for (const isHtml of [true, false]) {
      const out = htmlFor({ body: 'Hi', bodyIsHtml: isHtml }, sig);
      expect(out).toContain('Ann &lt;ann@x.test&gt;<br>Acme');
      expect(out).not.toContain('<ann@x.test>');
    }
  });
});

describe('rich-text campaigns end to end', () => {
  const conn = createRedis('test-rich');
  const queues = createQueues(conn, testPrefix());
  const sent: Parameters<SendFn>[1][] = [];
  const send: SendFn = async (_s, e) => {
    sent.push(e);
    return { messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null };
  };
  const app = createApp({ queues, send });
  let userId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: 3_600_000 };

  beforeAll(async () => {
    userId = (await makeUser('rich')).id;
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
  const job = (emailId: string) => ({ id: emailId, data: { emailId } as EmailJobData, opts: { attempts: 3 }, attemptsMade: 0, updateData: vi.fn(), moveToDelayed: vi.fn(), discard: vi.fn() }) as unknown as Job<EmailJobData>;

  async function schedule(body: string, bodyFormat: 'TEXT' | 'HTML', leads: { email: string; name?: string }[]) {
    const s = await makeSender();
    senderIds.push(s.id);
    const c = await createCampaign(userId, { subject: 'S', body, bodyFormat, leads, startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 100, senderIds: [s.id] }, { prisma, queues, config: cfg });
    return prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } });
  }

  it('stores sanitised HTML, escapes merge values, and derives a text preview', async () => {
    const [row] = await schedule('<p onclick="x()">Hi <b>{{name}}</b></p><script>alert(1)</script>', 'HTML', [{ email: `a-${randomUUID().slice(0, 6)}@x.dev`, name: '<img src=x onerror=alert(1)>Ann' }]);
    expect(row!.bodyIsHtml).toBe(true);
    expect(row!.body).toBe('<p>Hi <b>&lt;img src=x onerror=alert(1)&gt;Ann</b></p>');
    expect(row!.preview).toBe('Hi <img src=x onerror=alert(1)>Ann'); // text, not markup
    const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: row!.campaignId } });
    expect(camp).toMatchObject({ bodyFormat: 'HTML', body: '<p>Hi <b>{{name}}</b></p>' });
  });

  it('plain-text campaigns are untouched (no escaping, no HTML flag)', async () => {
    const [row] = await schedule('Hi {{name}} <b>', 'TEXT', [{ email: `t-${randomUUID().slice(0, 6)}@x.dev`, name: 'Tom & Jerry' }]);
    expect(row).toMatchObject({ bodyIsHtml: false, body: 'Hi Tom & Jerry <b>' });
  });

  it('refuses a body that is empty once sanitised', async () => {
    await expect(schedule('<script>alert(1)</script><div><br></div>', 'HTML', [{ email: `e-${randomUUID().slice(0, 6)}@x.dev` }])).rejects.toMatchObject({ status: 400 });
  });

  it('the worker hands the send function the HTML flag', async () => {
    const [row] = await schedule('<p>Hello <i>there</i></p>', 'HTML', [{ email: `w-${randomUUID().slice(0, 6)}@x.dev` }]);
    const run = createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: 3_600_000, minDelayMs: 0 }),
      send,
      logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000 },
      onRateLimited: async () => {},
    });
    sent.length = 0;
    expect(await run(job(row!.id), 't')).toEqual({ outcome: 'sent' });
    expect(sent[0]).toMatchObject({ bodyIsHtml: true, body: '<p>Hello <i>there</i></p>' });
  });

  it('the API validates bodyFormat, and test send sanitises and escapes', async () => {
    const bad = await request(app).post('/api/campaigns').set('Cookie', cookie()).send({ subject: 's', body: 'b', bodyFormat: 'PDF', leads: [{ email: 'a@x.dev' }], startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 10 });
    expect(bad.status).toBe(400);

    const s = await makeSender();
    senderIds.push(s.id);
    sent.length = 0;
    const res = await request(app)
      .post('/api/campaigns/test-send')
      .set('Cookie', cookie())
      .send({ subject: 'T', body: '<p>Hi {{name}}</p><script>x</script>', bodyFormat: 'HTML', senderId: s.id, sample: { email: 'p@x.dev', name: '<b>P</b>' } });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ bodyIsHtml: true, body: '<p>Hi &lt;b&gt;P&lt;/b&gt;</p>' });
  });
});
