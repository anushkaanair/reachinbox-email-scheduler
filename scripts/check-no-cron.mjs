// CI guard for the assignment's hard constraint: no cron of any kind.
// Scans backend source for cron libraries and interval-based schedulers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['apps/api/src', 'apps/api/package.json', 'package.json'];
// The SSE keep-alive ping is the single allowed timer; it never schedules work.
const ALLOW = [/modules[\\/]events[\\/]/];
const BANNED = [/node-cron/, /\bagenda\b/, /\bcrontab\b/, /\bcron\s*\(/, /setInterval\s*\(/, /node-schedule/];

const hits = [];
const walk = (p) => {
  const s = statSync(p);
  if (s.isDirectory()) return readdirSync(p).forEach((f) => walk(join(p, f)));
  if (ALLOW.some((re) => re.test(p))) return;
  readFileSync(p, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (BANNED.some((re) => re.test(line))) hits.push(`${p}:${i + 1}: ${line.trim()}`);
    });
};
ROOTS.forEach((r) => {
  try {
    walk(r);
  } catch {
    /* path may not exist yet */
  }
});

if (hits.length) {
  console.error('❌ Cron-like scheduling found (forbidden by the brief):\n' + hits.join('\n'));
  process.exit(1);
}
console.log('✅ no-cron check passed');
