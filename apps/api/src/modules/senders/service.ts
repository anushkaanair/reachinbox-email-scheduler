import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Sender } from '@prisma/client';
import {
  DEFAULT_WARMUP,
  guessProvider,
  rowToCreate,
  SMTP_PRESETS,
  type BulkAction,
  type ImportReport,
  type ImportRow,
  type ImportRowResult,
  type Reconnect,
  type SenderCreate,
  type SenderSettings,
} from '@ri/shared';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { SendFn } from '../../mail/transport.js';
import { checkDomain, type Resolver } from './dns.js';
import { assertPublicHost, explainSmtpError, type SmtpVerifier } from './smtp.js';

export type AccountDeps = { prisma: PrismaClient; verify: SmtpVerifier; resolver?: Resolver; send: SendFn };

const fullName = (first: string, last: string) => `${first} ${last}`.trim();

type Warmup = { enabled: boolean; target?: number; increment?: number };

/** Connect one account: resolve the SMTP settings, log in to prove they work, then store it (password encrypted). */
export async function createAccount(input: SenderCreate, deps: AccountDeps, warmup?: Warmup): Promise<Sender> {
  const provider = input.provider ?? guessProvider(input.email, input.smtpHost);
  const preset = SMTP_PRESETS[provider];
  const host = input.smtpHost ?? preset?.host;
  const port = input.smtpPort ?? preset?.port ?? 587;
  if (!host) throw new AppError(422, 'VALIDATION', 'SMTP host is required');
  const user = input.smtpUser ?? input.email;

  const existing = await deps.prisma.sender.findUnique({ where: { email: input.email } });
  if (existing?.isActive) throw new AppError(409, 'CONFLICT', `${input.email} is already connected`);

  await assertPublicHost(host);
  if (input.verify) {
    await deps.verify({ host, port, user, pass: input.smtpPass }).catch((e) => {
      throw new AppError(422, 'VALIDATION', explainSmtpError(e));
    });
  }

  const target = warmup?.target ?? DEFAULT_WARMUP.target;
  const data: Prisma.SenderUncheckedCreateInput = {
    email: input.email,
    displayName: fullName(input.firstName, input.lastName),
    firstName: input.firstName,
    lastName: input.lastName,
    provider,
    smtpHost: host,
    smtpPort: port,
    smtpUser: user,
    smtpPassEnc: encrypt(input.smtpPass),
    dailyLimit: input.dailyLimit ?? null,
    tags: input.tags ?? [],
    isActive: true,
    ...(warmup?.enabled
      ? {
          warmupEnabled: true,
          warmupStartedAt: new Date(),
          warmupTarget: target,
          warmupIncrement: warmup.increment ?? DEFAULT_WARMUP.increment,
          warmupStart: Math.min(DEFAULT_WARMUP.start, target),
        }
      : {}),
  };
  // A previously removed account comes back with fresh settings and a clean slate.
  if (existing) {
    return deps.prisma.sender.update({
      where: { id: existing.id },
      data: { ...data, consecutiveFailures: 0, lastError: null, pausedUntil: null, pauseReason: null, dnsResult: undefined, lastTestAt: null, lastTestOk: null },
    });
  }
  return deps.prisma.sender.create({ data });
}

/** Import mapped CSV rows one by one; a bad row never blocks the good ones. */
export async function importAccounts(rows: ImportRow[], verify: boolean, deps: AccountDeps): Promise<ImportReport> {
  const results: ImportRowResult[] = new Array(rows.length);
  const seen = new Set<string>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i]!;
      const email = (row.email ?? '').trim().toLowerCase();
      const n = i + 1;
      const mapped = rowToCreate(row);
      if ('error' in mapped) {
        results[i] = { row: n, email, status: 'failed', message: mapped.error };
        continue;
      }
      if (seen.has(mapped.create.email)) {
        results[i] = { row: n, email, status: 'skipped', message: 'Duplicate row in this file' };
        continue;
      }
      seen.add(mapped.create.email);
      try {
        await createAccount({ ...mapped.create, verify }, deps, mapped.warmup);
        results[i] = { row: n, email: mapped.create.email, status: 'created' };
      } catch (e) {
        const message = e instanceof AppError ? e.message : explainSmtpError(e);
        results[i] = e instanceof AppError && e.status === 409 ? { row: n, email, status: 'skipped', message } : { row: n, email, status: 'failed', message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, rows.length) }, worker));
  const count = (s: ImportRowResult['status']) => results.filter((r) => r.status === s).length;
  return { created: count('created'), skipped: count('skipped'), failed: count('failed'), results };
}

export function settingsData(s: SenderSettings, current?: Pick<Sender, 'firstName' | 'lastName'>): Prisma.SenderUpdateInput {
  const data: Prisma.SenderUpdateInput = {};
  if (s.dailyLimit !== undefined) data.dailyLimit = s.dailyLimit;
  if (s.hourlyLimit !== undefined) data.hourlyLimit = s.hourlyLimit;
  if (s.minDelaySeconds !== undefined) data.minDelayMs = s.minDelaySeconds === null ? null : s.minDelaySeconds * 1000;
  if (s.signature !== undefined) data.signature = s.signature?.trim() ? s.signature : null;
  if (s.replyTo !== undefined) data.replyTo = s.replyTo;
  if (s.tags !== undefined) data.tags = s.tags;
  if (current && (s.firstName !== undefined || s.lastName !== undefined)) {
    const first = s.firstName ?? current.firstName;
    const last = s.lastName ?? current.lastName;
    Object.assign(data, { firstName: first, lastName: last, displayName: fullName(first, last) });
  }
  return data;
}

export type BulkResult = { updated: number; skipped: { id: string; email: string; reason: string }[] };

export async function bulkAction(input: BulkAction, prisma: PrismaClient): Promise<BulkResult> {
  const senders = await prisma.sender.findMany({ where: { id: { in: input.ids }, isActive: true } });
  const ids = senders.map((s) => s.id);
  const skipped: BulkResult['skipped'] = [];
  if (ids.length === 0) return { updated: 0, skipped };

  switch (input.action) {
    case 'enable_warmup':
      await prisma.sender.updateMany({ where: { id: { in: ids } }, data: { warmupEnabled: true } });
      await prisma.sender.updateMany({ where: { id: { in: ids }, warmupStartedAt: null }, data: { warmupStartedAt: new Date() } });
      return { updated: ids.length, skipped };
    case 'pause_warmup':
      await prisma.sender.updateMany({ where: { id: { in: ids } }, data: { warmupEnabled: false } });
      return { updated: ids.length, skipped };
    case 'edit_settings':
      await prisma.sender.updateMany({ where: { id: { in: ids } }, data: settingsData(input.settings) as Prisma.SenderUpdateManyMutationInput });
      return { updated: ids.length, skipped };
    case 'add_tags':
      await prisma.$transaction(
        senders.map((s) => prisma.sender.update({ where: { id: s.id }, data: { tags: [...new Set([...s.tags, ...input.tags])].slice(0, 10) } })),
      );
      return { updated: ids.length, skipped };
    case 'delete': {
      // An account with emails still waiting would strand them, so those stay until the emails are sent or cancelled.
      const busy = await prisma.email.groupBy({ by: ['senderId'], where: { senderId: { in: ids }, status: { in: ['SCHEDULED', 'RATE_LIMITED', 'SENDING'] } }, _count: { _all: true } });
      const busyIds = new Map(busy.map((b) => [b.senderId, b._count._all]));
      const removable = senders.filter((s) => !busyIds.has(s.id));
      for (const s of senders.filter((x) => busyIds.has(x.id))) {
        skipped.push({ id: s.id, email: s.email, reason: `${busyIds.get(s.id)} email(s) still scheduled from this account` });
      }
      if (removable.length) await prisma.sender.updateMany({ where: { id: { in: removable.map((s) => s.id) } }, data: { isActive: false, warmupEnabled: false } });
      return { updated: removable.length, skipped };
    }
  }
}

/** Replace the credentials of an account that stopped working, prove they work, and clear the error. */
export async function reconnectAccount(sender: Sender, input: Reconnect, deps: AccountDeps): Promise<void> {
  const host = input.smtpHost ?? sender.smtpHost;
  const port = input.smtpPort ?? sender.smtpPort;
  const user = input.smtpUser ?? sender.smtpUser;
  await assertPublicHost(host);
  await deps.verify({ host, port, user, pass: input.smtpPass }).catch((e) => {
    throw new AppError(422, 'VALIDATION', explainSmtpError(e));
  });
  await deps.prisma.sender.update({
    where: { id: sender.id },
    data: { smtpHost: host, smtpPort: port, smtpUser: user, smtpPassEnc: encrypt(input.smtpPass), consecutiveFailures: 0, lastError: null, pausedUntil: null, pauseReason: null, errorAcknowledgedAt: null },
  });
}

/** "I've dealt with this at the provider": clear the error and any automatic pause without changing credentials. */
export async function acknowledgeError(senderId: string, prisma: PrismaClient): Promise<void> {
  await prisma.sender.update({
    where: { id: senderId },
    data: { consecutiveFailures: 0, lastError: null, pausedUntil: null, pauseReason: null, errorAcknowledgedAt: new Date() },
  });
}

export type TestResult = { ok: boolean; previewUrl: string | null; error: string | null };

/** Log in and send one real message to `to`, to prove the account works end to end. */
export async function testAccount(sender: Sender, to: string, deps: AccountDeps): Promise<TestResult> {
  let result: TestResult;
  try {
    await deps.verify({ host: sender.smtpHost, port: sender.smtpPort, user: sender.smtpUser, pass: decrypt(sender.smtpPassEnc) });
    const sent = await deps.send(sender, {
      emailId: randomUUID(),
      to,
      toName: null,
      subject: `Connection test from ${sender.email}`,
      body: 'This is a test email confirming that this account can send. You can ignore it.',
    });
    result = { ok: true, previewUrl: sent.previewUrl, error: null };
  } catch (e) {
    result = { ok: false, previewUrl: null, error: explainSmtpError(e) };
  }
  await deps.prisma.sender.update({ where: { id: sender.id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } });
  return result;
}

export async function runDnsCheck(sender: Sender, deps: Pick<AccountDeps, 'prisma' | 'resolver'>) {
  const domain = sender.email.split('@')[1]!;
  const report = await checkDomain(domain, deps.resolver);
  await deps.prisma.sender.update({ where: { id: sender.id }, data: { dnsResult: report as unknown as Prisma.InputJsonValue, dnsCheckedAt: new Date(report.checkedAt) } });
  return report;
}
