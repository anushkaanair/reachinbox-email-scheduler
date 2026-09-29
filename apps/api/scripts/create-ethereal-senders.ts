/**
 * Creates N fresh Ethereal (fake SMTP) accounts and registers them as senders.
 *   npm run senders:create -w @ri/api -- --count 3
 * Passwords are stored AES-256-GCM encrypted. Log in at https://ethereal.email/login with the
 * printed credentials to see every "sent" message.
 */
import nodemailer from 'nodemailer';
import { encrypt } from '../src/lib/crypto.js';
import { prisma } from '../src/lib/prisma.js';

const idx = process.argv.indexOf('--count');
const count = idx > -1 ? Number(process.argv[idx + 1]) : 3;
if (!Number.isInteger(count) || count < 1 || count > 20) {
  console.error('--count must be an integer between 1 and 20');
  process.exit(1);
}

const existing = await prisma.sender.count();
if (process.argv.includes('--if-empty') && existing > 0) {
  console.log(`${existing} sender(s) already registered — skipping (--if-empty).`);
  await prisma.$disconnect();
  process.exit(0);
}
console.log(`Creating ${count} Ethereal sender(s) (${existing} already registered)…\n`);

for (let i = 0; i < count; i++) {
  const acc = await nodemailer.createTestAccount();
  const n = existing + i + 1;
  await prisma.sender.upsert({
    where: { email: acc.user },
    create: {
      email: acc.user,
      displayName: `ReachInbox Sender ${n}`,
      smtpHost: acc.smtp.host,
      smtpPort: acc.smtp.port,
      smtpUser: acc.user,
      smtpPassEnc: encrypt(acc.pass),
    },
    update: {},
  });
  console.log(`  ✓ ${acc.user}   (ethereal login password: ${acc.pass})`);
}

console.log('\nInbox viewer: https://ethereal.email/login');
await prisma.$disconnect();
