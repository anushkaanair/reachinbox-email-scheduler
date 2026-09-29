/**
 * DEV ONLY — prints a session token for a local test user so the dashboard can be exercised
 * before Google OAuth credentials exist. Refuses to run in production.
 *   npx tsx scripts/dev-session.ts   → paste as cookie `ri_session=<token>` on localhost
 */
import { env } from '../src/config/env.js';
import { prisma } from '../src/lib/prisma.js';
import { setSession } from '../src/modules/auth/session.js';

if (env.isProd) {
  console.error('dev-session is disabled in production');
  process.exit(1);
}

const user = await prisma.user.upsert({
  where: { googleId: 'local-dev-user' },
  create: { googleId: 'local-dev-user', email: 'dev@local.test', name: 'Local Dev' },
  update: {},
});
let token = '';
setSession({ cookie: (_name: string, value: string) => (token = value) } as never, user.id);
console.log(token);
await prisma.$disconnect();
process.exit(0);
