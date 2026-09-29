import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { encrypt } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';

export const silentLogger = pino({ level: 'silent' });

/** Unique namespace per test run: BullMQ prefix + rate-limit key prefix. Never touches live data. */
export const testPrefix = () => `t${randomUUID().slice(0, 8)}`;

export async function makeUser(tag = 'u') {
  const id = randomUUID();
  return prisma.user.create({
    data: { googleId: `test-${id}`, email: `${tag}-${id}@test.dev`, name: `Test ${tag}` },
  });
}

export async function makeSender(overrides: { hourlyLimit?: number } = {}) {
  return prisma.sender.create({
    data: {
      email: `sender-${randomUUID()}@test.dev`,
      displayName: 'Test Sender',
      smtpUser: 'u',
      smtpPassEnc: encrypt('p'),
      hourlyLimit: overrides.hourlyLimit ?? null,
      // test.dev addresses; deleted in afterAll.
      isActive: true,
    },
  });
}

export async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const statusCounts = async (campaignId: string) => {
  const g = await prisma.email.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } });
  return Object.fromEntries(g.map((x) => [x.status, x._count._all])) as Record<string, number>;
};
