import { randomUUID } from 'node:crypto';
import '../src/config/env.js'; // loads the root .env before Prisma is constructed
import type { Job } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanFileName, extensionOf, formatBytes, MAX_ATTACHMENT_BYTES } from '@ri/shared';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { createRedis, redis } from '../src/lib/redis.js';
import { createAttachmentLoader } from '../src/mail/attachments.js';
import type { SendFn } from '../src/mail/transport.js';
import { checkUpload } from '../src/modules/attachments/validate.js';
import { setSession } from '../src/modules/auth/session.js';
import { createCampaign } from '../src/modules/campaigns/service.js';
import { createEmailProcessor } from '../src/queues/emailProcessor.js';
import { closeQueues, createQueues, type EmailJobData } from '../src/queues/queues.js';
import { RateLimiter } from '../src/throttle/rateLimiter.js';
import { makeSender, makeUser, silentLogger, testPrefix } from './helpers.js';

const PNG = (extra = 16) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 7)]);
const PDF = Buffer.from('%PDF-1.4\n%%EOF');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

describe('file names and sizes (shared)', () => {
  it('cleans names: no path, no control characters, no leading dots, bounded length', () => {
    expect(cleanFileName('../../etc/passwd.png')).toBe('passwd.png');
    expect(cleanFileName('C:\\Users\\me\\report final.pdf')).toBe('report final.pdf');
    expect(cleanFileName('a\u0000b\r\n"<c>|.txt')).toBe('abc.txt');
    expect(cleanFileName('...hidden.txt')).toBe('hidden.txt');
    const long = cleanFileName(`${'x'.repeat(300)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(cleanFileName('   ')).toBe('');
  });
  it('reads extensions and formats sizes', () => {
    expect(extensionOf('a.tar.GZ')).toBe('gz');
    expect(extensionOf('noext')).toBe('');
    expect([formatBytes(500), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(['500 B', '2.0 KB', '3.0 MB']);
  });
});

describe('checkUpload (what may be attached)', () => {
  it('accepts real files and decides the type itself', () => {
    expect(checkUpload('Photo.PNG', PNG())).toEqual({ ok: true, fileName: 'Photo.PNG', contentType: 'image/png' });
    expect(checkUpload('a.pdf', PDF)).toMatchObject({ ok: true, contentType: 'application/pdf' });
    expect(checkUpload('a.docx', ZIP)).toMatchObject({ ok: true });
    expect(checkUpload('notes.txt', Buffer.from('plain text'))).toMatchObject({ ok: true, contentType: 'text/plain' });
    expect(checkUpload('leads.csv', Buffer.from('a,b\n1,2'))).toMatchObject({ ok: true, contentType: 'text/csv' });
  });
  it('rejects types that could run or script, however they are named', () => {
    for (const name of ['virus.exe', 'page.html', 'logo.svg', 'run.js', 'x.sh', 'x.bat', 'archive.zip', 'noext', 'x.png.exe', 'x.php']) {
      expect(checkUpload(name, PNG()), name).toMatchObject({ ok: false });
    }
  });
  it('rejects files that are not what their extension claims', () => {
    expect(checkUpload('fake.png', Buffer.from('MZ\u0090\u0000 not a png'))).toMatchObject({ ok: false, message: expect.stringContaining('real .png') });
    expect(checkUpload('fake.pdf', PNG())).toMatchObject({ ok: false });
    expect(checkUpload('fake.jpg', PDF)).toMatchObject({ ok: false });
    expect(checkUpload('fake.docx', PDF)).toMatchObject({ ok: false });
    expect(checkUpload('binary.txt', Buffer.from([65, 66, 0, 67]))).toMatchObject({ ok: false });
  });
  it('rejects empty, oversized and nameless uploads', () => {
    expect(checkUpload('a.png', Buffer.alloc(0))).toMatchObject({ ok: false, message: expect.stringContaining('empty') });
    expect(checkUpload('a.png', Buffer.concat([PNG(), Buffer.alloc(MAX_ATTACHMENT_BYTES)]))).toMatchObject({ ok: false, message: expect.stringContaining('5 MB') });
    expect(checkUpload('', PNG())).toMatchObject({ ok: false });
    expect(checkUpload('../', PNG())).toMatchObject({ ok: false });
  });
});

describe('attachments API and sending', () => {
  const conn = createRedis('test-attach');
  const queues = createQueues(conn, testPrefix());
  const sent: Parameters<SendFn>[1][] = [];
  const send: SendFn = async (_s, e) => {
    sent.push(e);
    return { messageId: `<${e.emailId}@reachinbox.local>`, previewUrl: null };
  };
  const app = createApp({ queues, send });
  let userId: string;
  let otherId: string;
  const senderIds: string[] = [];
  const cfg = { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, minDelayMs: 0, windowMs: 3_600_000 };

  beforeAll(async () => {
    userId = (await makeUser('attach')).id;
    otherId = (await makeUser('attach-other')).id;
    const keys = await redis.keys('reqlimit:attach:*');
    if (keys.length) await redis.del(...keys);
  });
  afterAll(async () => {
    for (const q of [queues.email, queues.notify, queues.index]) await q.obliterate({ force: true });
    await closeQueues(queues);
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.sender.deleteMany({ where: { id: { in: senderIds } } });
    await conn.quit();
  });
  const cookieFor = (id: string) => {
    let h = '';
    setSession({ cookie: (n: string, v: string) => (h = `${n}=${v}`) } as never, id);
    return h;
  };
  const upload = (who: string, name: string, data: Buffer, type = 'application/octet-stream') =>
    request(app).post(`/api/attachments?name=${encodeURIComponent(name)}`).set('Cookie', cookieFor(who)).set('Content-Type', type).send(data);
  const clear = () => prisma.attachment.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  const job = (emailId: string) => ({ id: emailId, data: { emailId } as EmailJobData, opts: { attempts: 3 }, attemptsMade: 0, updateData: vi.fn(), moveToDelayed: vi.fn(), discard: vi.fn() }) as unknown as Job<EmailJobData>;
  const processor = () =>
    createEmailProcessor({
      prisma,
      limiter: new RateLimiter(redis, { prefix: `${testPrefix()}:`, windowMs: 3_600_000, minDelayMs: 0 }),
      send,
      logger: silentLogger,
      config: { maxPerWindowGlobal: 1e6, maxPerWindowPerSender: 1e6, staleSendingMs: 60_000 },
      onRateLimited: async () => {},
    });
  async function schedule(attachmentIds: string[], n = 1, who = userId) {
    const s = await makeSender();
    senderIds.push(s.id);
    const c = await createCampaign(who, { subject: 'S', body: 'b', attachmentIds, leads: Array.from({ length: n }, () => ({ email: `a-${randomUUID().slice(0, 6)}@x.dev` })), startAt: new Date().toISOString(), delayBetweenSeconds: 0, hourlyLimit: 100, senderIds: [s.id] }, { prisma, queues, config: cfg });
    return { campaignId: c.campaignId, emails: await prisma.email.findMany({ where: { campaignId: c.campaignId }, orderBy: { sequence: 'asc' } }) };
  }

  it('requires sign-in', async () => {
    expect((await request(app).post('/api/attachments?name=a.png').send(PNG())).status).toBe(401);
    expect((await request(app).get('/api/attachments/x/download')).status).toBe(401);
  });

  it('stores an upload, ignoring the type the browser claims', async () => {
    await clear();
    const res = await upload(userId, 'Logo.png', PNG(100), 'text/html'); // a lie about the type
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fileName: 'Logo.png', contentType: 'image/png', size: 108 });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ userId, campaignId: null });
    expect(Buffer.from(row.data).equals(PNG(100))).toBe(true);
  });

  it('refuses bad uploads with a reason', async () => {
    await clear();
    expect((await upload(userId, 'virus.exe', PNG())).status).toBe(422);
    const spoof = await upload(userId, 'fake.png', Buffer.from('not a png at all'));
    expect(spoof.status).toBe(422);
    expect(spoof.body.error.message).toMatch(/real \.png/);
    expect((await upload(userId, '', PNG())).status).toBe(422);
    expect((await upload(userId, 'big.png', Buffer.concat([PNG(), Buffer.alloc(MAX_ATTACHMENT_BYTES)]))).status).toBe(413);
    expect(await prisma.attachment.count({ where: { userId } })).toBe(0);
  });

  it('caps the number of files and their total size', async () => {
    await clear();
    for (let i = 0; i < 5; i++) expect((await upload(userId, `f${i}.png`, PNG())).status).toBe(201);
    const sixth = await upload(userId, 'f5.png', PNG());
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.message).toMatch(/up to 5 files/);
    await clear();
    const big = () => Buffer.concat([PNG(), Buffer.alloc(4 * 1024 * 1024, 1)]);
    expect((await upload(userId, 'a.png', big())).status).toBe(201);
    expect((await upload(userId, 'b.png', big())).status).toBe(201);
    expect((await upload(userId, 'c.png', big())).status).toBe(409); // 12 MB > 10 MB
  });

  it('downloads only the owner’s files, as an attachment that cannot be sniffed into something else', async () => {
    await clear();
    const up = await upload(userId, 'Quarterly Report.pdf', PDF);
    const ok = await request(app).get(`/api/attachments/${up.body.id}/download`).set('Cookie', cookieFor(userId));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
    expect(ok.headers['content-disposition']).toContain('attachment;');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(ok.body).equals(PDF)).toBe(true);
    expect((await request(app).get(`/api/attachments/${up.body.id}/download`).set('Cookie', cookieFor(otherId))).status).toBe(404);
  });

  it('deletes staged files only, and only your own', async () => {
    await clear();
    const up = await upload(userId, 'a.png', PNG());
    expect((await request(app).delete(`/api/attachments/${up.body.id}`).set('Cookie', cookieFor(otherId))).status).toBe(404);
    expect((await request(app).delete(`/api/attachments/${up.body.id}`).set('Cookie', cookieFor(userId))).status).toBe(204);
    const again = await upload(userId, 'b.png', PNG());
    await schedule([again.body.id]);
    expect((await request(app).delete(`/api/attachments/${again.body.id}`).set('Cookie', cookieFor(userId))).status).toBe(404); // already attached to a campaign
  });

  it('removes staged files nobody scheduled, the next time the owner uploads', async () => {
    await clear();
    const stale = await prisma.attachment.create({ data: { userId, fileName: 'old.png', contentType: 'image/png', size: 4, data: new Uint8Array([1, 2, 3, 4]), createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    const fresh = await upload(userId, 'new.png', PNG());
    expect(fresh.status).toBe(201);
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await prisma.attachment.count({ where: { userId } })).toBe(1);
  });

  it('attaches files to a campaign, and refuses foreign, missing or already-used files', async () => {
    await clear();
    const a = await upload(userId, 'a.png', PNG());
    const theirs = await upload(otherId, 'theirs.png', PNG());
    const campaignsBefore = await prisma.campaign.count({ where: { userId } });
    await expect(schedule([theirs.body.id])).rejects.toMatchObject({ status: 400 });
    await expect(schedule(['does-not-exist'])).rejects.toMatchObject({ status: 400 });
    expect(await prisma.campaign.count({ where: { userId } })).toBe(campaignsBefore); // a refused attachment leaves nothing half-created

    const ok = await schedule([a.body.id]);
    expect(await prisma.attachment.findUniqueOrThrow({ where: { id: a.body.id } })).toMatchObject({ campaignId: ok.campaignId });
    await expect(schedule([a.body.id])).rejects.toMatchObject({ status: 400 }); // a file goes with one campaign
  });

  it('every email of the campaign is sent with the files, read from the database once', async () => {
    await clear();
    const png = await upload(userId, 'pic.png', PNG(50));
    const pdf = await upload(userId, 'doc.pdf', PDF);
    const { emails } = await schedule([png.body.id, pdf.body.id], 3);
    sent.length = 0;
    const run = processor();
    for (const e of emails) expect(await run(job(e.id), 't')).toEqual({ outcome: 'sent' });
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      expect(m.attachments?.map((a) => [a.filename, a.contentType])).toEqual([['pic.png', 'image/png'], ['doc.pdf', 'application/pdf']]);
      expect(Buffer.isBuffer(m.attachments![0]!.content)).toBe(true);
    }
    expect(sent[0]!.attachments![0]!.content.equals(PNG(50))).toBe(true);
  });

  it('a campaign without files sends none', async () => {
    const { emails } = await schedule([]);
    sent.length = 0;
    await processor()(job(emails[0]!.id), 't');
    expect(sent[0]!.attachments).toBeUndefined();
  });

  it('the loader hits the database once per campaign and forgets failures', async () => {
    const findMany = vi.fn().mockResolvedValue([{ fileName: 'a.txt', contentType: 'text/plain', data: new Uint8Array([104, 105]) }]);
    const load = createAttachmentLoader({ attachment: { findMany } } as never, 2);
    const [a, b] = await Promise.all([load('c1'), load('c1')]);
    await load('c1');
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a[0]!.content.toString()).toBe('hi');
    await load('c2');
    await load('c3'); // c1 is evicted (limit 2)
    await load('c1');
    expect(findMany).toHaveBeenCalledTimes(4);

    const failing = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([]);
    const l2 = createAttachmentLoader({ attachment: { findMany: failing } } as never);
    await expect(l2('x')).rejects.toThrow('db down');
    expect(await l2('x')).toEqual([]); // the failure was not cached
  });

  it('the email detail lists the campaign’s files', async () => {
    await clear();
    const up = await upload(userId, 'brief.pdf', PDF);
    const { emails } = await schedule([up.body.id]);
    const res = await request(app).get(`/api/emails/${emails[0]!.id}`).set('Cookie', cookieFor(userId));
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([{ id: up.body.id, fileName: 'brief.pdf', contentType: 'application/pdf', size: PDF.length }]);
  });
});
