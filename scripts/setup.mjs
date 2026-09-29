#!/usr/bin/env node
// One-command local setup:  npm run setup
// Idempotent — safe to re-run. Creates .env (with fresh secrets), starts Postgres/Redis/
// Elasticsearch, applies migrations, creates Ethereal senders if none exist, builds the search index.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const step = (msg) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ Failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

step('Checking prerequisites');
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`✖ Node ${process.versions.node} found; Node 20+ is required.`);
  process.exit(1);
}
if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('✖ Docker is not running. Start Docker Desktop and re-run `npm run setup`.');
  process.exit(1);
}
console.log(`  node ${process.versions.node} ✓  docker ✓`);

step('Environment (.env)');
if (existsSync('.env')) {
  console.log('  .env exists — leaving it untouched');
} else {
  const env = readFileSync('.env.example', 'utf8')
    .replace(/^JWT_SECRET=$/m, `JWT_SECRET=${randomBytes(48).toString('base64url')}`)
    .replace(/^ENCRYPTION_KEY=$/m, `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
  writeFileSync('.env', env);
  console.log('  created .env with freshly generated JWT_SECRET and ENCRYPTION_KEY');
}

step('Starting Postgres, Redis (AOF) and Elasticsearch');
run('docker', ['compose', 'up', '-d', '--wait']);

step('Database migrations');
run('npm', ['run', 'db:deploy', '-w', '@ri/api']);

step('Ethereal sender accounts');
run('npm', ['run', 'senders:create', '-w', '@ri/api', '--', '--count', '3', '--if-empty']);

step('Search index');
run('npm', ['run', 'reindex', '-w', '@ri/api']);

const envText = readFileSync('.env', 'utf8');
const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => new RegExp(`^${k}=\\s*$`, 'm').test(envText));
console.log('\n\x1b[32m✔ Setup complete.\x1b[0m\n');
console.log('  Start everything:   npm run dev        → http://localhost:5173');
console.log('  Demo mode (60s windows, 4/sender):   npm run dev:demo');
if (missing.length) console.log(`\n  ⚠ Add ${missing.join(' and ')} to .env for Google login (see README → Google OAuth).`);
