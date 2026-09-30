import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the monorepo-root .env (src/config → ../../../../.env; same depth from dist/config).
const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: int(4000, 1),
  WEB_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().default('http://localhost:4000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6380'),
  ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
  ES_INDEX: z.string().regex(/^[a-z0-9-]+$/).default('emails'),

  // Optional so the server can boot before credentials exist; the feature returns 503 until set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().url().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().url().optional(),

  /** Comma-separated emails allowed to open Bull Board; empty = any signed-in user (dev). */
  ADMIN_EMAILS: z.string().optional(),

  /** Length of one warm-up "day" in seconds (86400; shorten in demo mode to watch the ramp). */
  WARMUP_DAY_SECONDS: int(86_400, 60),
  /** Pause a sender after this many failed sends in a row (circuit breaker). */
  SENDER_PAUSE_AFTER_FAILURES: int(5, 1),
  /** How long an automatically paused sender cools down, in minutes. */
  SENDER_PAUSE_MINUTES: int(30, 1),

  /**
   * Allow connecting SMTP accounts whose host resolves to a loopback/private address. Off by default:
   * the "connect account" form takes a user-supplied host, and this stops it probing the internal network.
   */
  ALLOW_PRIVATE_SMTP_HOSTS: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  WORKER_CONCURRENCY: int(5, 1),
  MIN_DELAY_BETWEEN_EMAILS_MS: int(2000),
  MAX_EMAILS_PER_HOUR: int(200, 1),
  MAX_EMAILS_PER_HOUR_PER_SENDER: int(50, 1),
  RATE_WINDOW_SECONDS: int(3600, 10),
  EMAIL_MAX_ATTEMPTS: int(3, 1),
  STALE_SENDING_MS: int(300_000, 1000),
});

// `KEY=` in .env means "unset", not "empty string".
const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const parsed = EnvSchema.safeParse(raw);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  console.error('   → copy .env.example to .env at the repo root and fill it in.');
  process.exit(1);
}

const e = parsed.data;

export const env = {
  ...e,
  isProd: e.NODE_ENV === 'production',
  GOOGLE_CALLBACK_URL: e.GOOGLE_CALLBACK_URL ?? `${e.API_URL}/api/auth/google/callback`,
  googleConfigured: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
  adminEmails: (e.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  slackConfigured: Boolean(e.SLACK_CLIENT_ID && e.SLACK_CLIENT_SECRET && e.SLACK_REDIRECT_URI),
};
export type Env = typeof env;
