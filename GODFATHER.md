# 🧠 GODFATHER.md — ReachInbox Email Job Scheduler

> **Single source of truth.** Every agent reads this file first, works only inside its lane,
> and updates the **Progress Board** (§14) when it finishes a task.
> If a decision here conflicts with your instinct, this file wins. If this file is wrong, fix it here first.

- **Assignment:** ReachInbox (Outbox Labs), Software Development Intern, "Full-stack Email Job Scheduler"
- **Nature:** an elimination round. **Every stated requirement must be met *exactly* and be demonstrable.** Extras come only after the core is fully working.
- **Inspiration:** https://reachinbox.ai: "Smart Time Gaps", Onebox, live analytics, sender Health Score, Slack alerts
- **Figma:** https://www.figma.com/design/kOTwGlESjijCYnMgtHfvfU/Outbox-Labs-Assignment?node-id=59-4050 (see §9.0; access is currently blocked)

---

## 0. Golden Rules (non-negotiable)

1. **No cron. Anywhere.** No `crontab`, no `node-cron`, no `agenda`, no `setInterval` pollers that schedule sends. All timing comes from **BullMQ delayed jobs**. CI greps for this (§12.4).
2. **Never send an email twice.** Idempotency is enforced at three layers (§5.4).
3. **Never drop a job when a rate limit is hit.** Move it to a later time; never fail it (§6).
4. **All limits come from env/config.** No magic numbers in code.
5. **Rate-limit state lives in Redis**, never only in memory, so it is safe across workers and instances.
6. **Restart-safe.** Redis uses AOF persistence. Postgres is the source of truth. A boot-time reconciler repairs any drift (§5.5).
7. **TypeScript strict mode** in every package. No `any` without a `// reason:` comment.
8. **Every requirement maps to a demo moment** (§13). If we can't show it, it doesn't count.

---

## 1. Requirement → Implementation Traceability Matrix

This is the checklist the reviewers will mentally run. Each row must be ✅ before submission.

| # | Requirement (from brief) | How we satisfy it | Owner | Proof in demo/README |
|---|---|---|---|---|
| R1 | TypeScript + Express backend | `apps/api` (Express 4, TS strict) | A2 | repo |
| R2 | BullMQ + Redis scheduler, no cron | Delayed jobs, `delay = scheduledAt - now` | A4 | README §Scheduling |
| R3 | Postgres/MySQL storage | PostgreSQL 16 + Prisma | A3 | schema.prisma |
| R4 | Ethereal SMTP, **multiple senders** | `senders` table seeded with N Ethereal accounts, round-robin or user-picked | A6 | Sent tab → Ethereal preview link |
| R5 | Emails searchable via **Elasticsearch** | `emails` index; indexed on create and on every status change; `/api/emails/search` | A6 | search bar demo |
| R6 | **Live BullMQ dashboard** | `@bull-board/express` at `/admin/queues` (auth-protected) | A4 | demo |
| R7 | Survive restart: future emails still send on time | Redis AOF, delayed jobs persist, boot reconciler | A4 | restart demo |
| R8 | No duplicates / no restart from scratch | jobId = emailId, DB state machine with conditional update, deterministic Message-ID | A4 | README §Idempotency |
| R9 | Configurable worker concurrency, parallel-safe | `WORKER_CONCURRENCY` env; all shared state goes through atomic Redis Lua or DB | A4/A5 | README |
| R10 | Minimum delay between sends | Per-sender "next slot" reservation (Redis Lua) = `MIN_DELAY_BETWEEN_EMAILS_MS` (default **2000 ms**), plus campaign stagger from the compose form | A5 | README + load demo |
| R11 | Emails-per-hour limit, env-configurable, Redis-backed | `MAX_EMAILS_PER_HOUR` (global) + `MAX_EMAILS_PER_HOUR_PER_SENDER` + per-campaign `hourlyLimit` (from the UI); effective = min | A5 | README |
| R12 | On limit: delay to the next hour window, keep order | `moveToDelayed(nextWindowStart + rank × minDelay)` | A5 | load demo |
| R13 | Slack OAuth "Connect Slack", token stored per user | OAuth v2 (`incoming-webhook`, `chat:write`), encrypted token per user | A6 | live Slack message in demo |
| R14 | Slack message **the moment** a sender hits its hourly limit | Notification queue job, deduped per sender per hour | A6 | demo |
| R15 | No Slack connected → no crash; connect later → works without redeploy | Token looked up at send time, no-op if absent | A6 | demo disconnect/reconnect |
| R16 | 1000+ emails at the same time | Bulk insert + `addBulk` chunks + limiter math (§6.5) | A5/A9 | load script + README |
| R17 | React/Next + Tailwind + TS frontend matching Figma | Vite + React 18 + TS + Tailwind + React Router + TanStack Query | A7/A8 | demo |
| R18 | Real Google OAuth; header shows name, email, avatar; logout | Backend Passport Google strategy, httpOnly JWT cookie | A3/A7 | demo |
| R19 | Dashboard: header, Scheduled/Sent tabs, "Compose New Email" button | `DashboardLayout` | A7 | demo |
| R20 | Compose: subject, body, CSV/text upload with count, start time, delay, hourly limit, Schedule | `ComposePage` / modal | A7 | demo |
| R21 | Scheduled table: email, subject, scheduled time, status + loading + empty | `EmailTable` variant | A7 | demo |
| R22 | Sent table: email, subject, sent time, status (sent/failed) + loading + empty | `EmailTable` variant | A7 | demo |
| R23 | Clean structure, reusable components, DRY, typed API | `packages/shared` types, `components/ui/*` | A7/A8 | repo |
| R24 | Loading, empty and error (toasts) states | skeletons, `EmptyState`, `sonner` toasts | A7 | demo |
| R25 | README: run backend/frontend, Ethereal and env setup, architecture, feature map, trade-offs | `README.md` | A10 | repo |
| R26 | Demo video ≤ 5 min incl. restart + (bonus) rate limit under load | script in §13 | A10 | video |
| R27 | Private GitHub repo, access for `Mitrajit` and `Yadav036` | done by the human (Anushka) at the end | Human | invite sent |

### 1.1 Status of every requirement (2026-09-29, end of Phase 6 build)

| Rows | Status | Notes |
|---|---|---|
| R1–R12, R16 (backend core, persistence, idempotency, throttling, load) | ✅ | Proven on real Ethereal SMTP + drills A–D (`docs/VERIFICATION.md`) |
| R13, R14 (Slack OAuth + alert on limit) | 🟨 | Fully built; 11 tests against the real routes with Slack's HTTP API mocked. **Needs one live run with the Slack app + tunnel.** |
| R15 (no Slack → no crash; reconnect without redeploy) | ✅ | Tested (skip when disconnected, dead-webhook → reconnect, reconnect works immediately) |
| R17 (frontend matches Figma) | 🟨 | Built with the required layout & states; **pixel match unverified — Figma export still pending** |
| R18 (real Google OAuth) | 🟨 | Implemented + tested up to Google; **needs GOOGLE_CLIENT_ID/SECRET for a live login** |
| R19–R25 (dashboard, compose, tables, states, code quality, README) | ✅ | README mirrors the brief's submission list |
| R26 (demo video) | ⬜ | Script ready: `docs/DEMO_SCRIPT.md` — to be recorded by Anushka |
| R27 (private repo + invite Mitrajit, Yadav036) | ⬜ | Human step |

---

## 2. Tech Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Monorepo | **npm workspaces**: `apps/api`, `apps/web`, `packages/shared` | Shared types means no drift between API and UI |
| Backend | Node 20, **Express 4**, TypeScript strict, `zod` validation, `pino` logs | Required, plus production hygiene |
| Queue | **BullMQ 5** + ioredis | Required |
| Queue UI | `@bull-board/express` + `@bull-board/api` | "Live BullMQ dashboard" |
| DB | **PostgreSQL 16** + **Prisma** | Typed, migrations, easy seeding |
| Search | **Elasticsearch 8** (single node, security off locally) + `@elastic/elasticsearch` | Required |
| SMTP | **nodemailer** + Ethereal accounts | Required |
| Auth | `passport` + `passport-google-oauth20`, JWT in an httpOnly cookie | Real OAuth, backend owns users (needed for per-user Slack) |
| Slack | Raw OAuth v2 via `fetch` + `@slack/web-api` | Real authorize flow |
| Realtime | **Server-Sent Events** (`/api/events`) backed by BullMQ `QueueEvents` | Live table updates (extra feature F1) |
| Frontend | **Vite + React 18 + TS**, React Router 6, **TanStack Query**, **Tailwind**, `react-hook-form` + `zod`, `papaparse`, `sonner`, `lucide-react`, `date-fns` | Fast, simple and typed. No SSR auth complexity. |
| Charts | `recharts` | Analytics (extra feature F4) |
| Tests | **Vitest** + Supertest; Redis/PG from docker-compose in CI | |
| Infra | **docker-compose**: postgres, redis (AOF on), elasticsearch, (kibana optional) | "Recommended" |
| Tunnel | `cloudflared` or `ngrok` | Slack OAuth needs an HTTPS redirect URL |

---

## 3. Repository Layout

```
reachinbox-scheduler/
├── GODFATHER.md                 ← this file
├── README.md                    ← submission README (A10)
├── docker-compose.yml           ← postgres, redis(AOF), elasticsearch
├── .env.example                 ← every env var, documented
├── package.json (npm workspaces)
├── packages/
│   └── shared/                  ← zod schemas + TS types shared by api & web
│       └── src/{email.ts, campaign.ts, sender.ts, api.ts, events.ts}
├── apps/
│   ├── api/
│   │   ├── prisma/{schema.prisma, seed.ts, migrations/}
│   │   ├── scripts/{create-ethereal-senders.ts, load-test.ts, restart-demo.sh}
│   │   └── src/
│   │       ├── config/env.ts            ← zod-validated env (fail fast)
│   │       ├── lib/{prisma.ts, redis.ts, logger.ts, crypto.ts, es.ts}
│   │       ├── modules/
│   │       │   ├── auth/        (google strategy, jwt, requireAuth middleware, routes)
│   │       │   ├── campaigns/   (controller, service, routes: create/list/cancel/pause)
│   │       │   ├── emails/      (controller, service, routes: list/search/retry/detail)
│   │       │   ├── senders/     (list, usage/quota)
│   │       │   ├── slack/       (oauth routes, token store, notifier)
│   │       │   ├── search/      (es index mgmt, indexer)
│   │       │   ├── analytics/   (hourly stats)
│   │       │   └── events/      (SSE hub)
│   │       ├── queues/
│   │       │   ├── connection.ts
│   │       │   ├── names.ts             ← EMAIL_QUEUE, NOTIFY_QUEUE, INDEX_QUEUE
│   │       │   ├── email.queue.ts       ← enqueue helpers (jobId = emailId)
│   │       │   ├── email.worker.ts      ← THE worker (idempotent send pipeline)
│   │       │   ├── notify.worker.ts     ← Slack
│   │       │   ├── index.worker.ts      ← Elasticsearch sync
│   │       │   └── bullboard.ts
│   │       ├── throttle/
│   │       │   ├── lua/{reserve_slot.lua, hourly_quota.lua}
│   │       │   ├── rateLimiter.ts       ← wraps Lua, pure, unit-tested
│   │       │   └── windows.ts           ← hour-window math (UTC)
│   │       ├── recovery/reconciler.ts   ← boot-time drift repair
│   │       ├── mail/{transportPool.ts, send.ts}
│   │       ├── app.ts                   ← express app (no listen)
│   │       ├── server.ts                ← API process entry
│   │       └── worker.ts                ← worker process entry (separate process!)
│   │   └── test/{unit, integration}
│   └── web/
│       └── src/
│           ├── app/{router.tsx, providers.tsx}
│           ├── api/{client.ts, emails.ts, campaigns.ts, auth.ts, slack.ts, senders.ts}
│           ├── hooks/{useAuth.ts, useEmails.ts, useLiveEvents.ts, useCsvLeads.ts}
│           ├── components/
│           │   ├── ui/        (Button, Input, Textarea, Select, Modal, Tabs, Table,
│           │   │               Badge, Avatar, Skeleton, EmptyState, Spinner, Dropzone, DateTimePicker)
│           │   ├── layout/    (Header, Sidebar, DashboardLayout, UserMenu)
│           │   └── email/     (EmailTable, StatusBadge, EmailDetailDrawer, SearchBar)
│           ├── pages/{LoginPage, DashboardPage, ScheduledPage, SentPage, ComposePage,
│           │          SettingsPage (Slack), AnalyticsPage, AuthCallbackPage, NotFound}
│           ├── lib/{format.ts, csv.ts, cn.ts}
│           └── styles/index.css
└── .github/workflows/ci.yml     ← typecheck, lint, test, "no-cron" grep
```

**Why two backend processes (`server.ts` and `worker.ts`):** it proves restart-safety (kill either one independently), it proves multi-instance safety (run 2 workers), and it mirrors production.

---

## 4. Data Model (Prisma, PostgreSQL)

```prisma
model User {
  id          String   @id @default(cuid())
  googleId    String   @unique
  email       String   @unique
  name        String
  avatarUrl   String?
  createdAt   DateTime @default(now())
  campaigns   Campaign[]
  slack       SlackConnection?
}

model SlackConnection {           // one per user (tenant = user for this assignment)
  id              String   @id @default(cuid())
  userId          String   @unique
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  teamId          String
  teamName        String
  channelId       String
  channelName     String
  webhookUrlEnc   String           // AES-256-GCM encrypted
  botTokenEnc     String?          // encrypted, for chat:write / auth.revoke
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model Sender {                    // Ethereal SMTP accounts
  id            String  @id @default(cuid())
  email         String  @unique
  displayName   String
  smtpHost      String  @default("smtp.ethereal.email")
  smtpPort      Int     @default(587)
  smtpUser      String
  smtpPassEnc   String          // encrypted
  hourlyLimit   Int?            // optional per-sender override; else env default
  isActive      Boolean @default(true)
  emails        Email[]
}

model Campaign {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id])
  subject          String
  body             String           // supports {{merge_tags}}
  startAt          DateTime
  delayBetweenMs   Int              // from compose form
  hourlyLimit      Int              // from compose form
  senderStrategy   SenderStrategy   @default(ROUND_ROBIN)
  status           CampaignStatus   @default(ACTIVE)
  totalRecipients  Int
  createdAt        DateTime @default(now())
  emails           Email[]
  @@index([userId, createdAt])
}

model Email {
  id              String      @id @default(cuid())   // == BullMQ jobId
  campaignId      String
  campaign        Campaign    @relation(fields: [campaignId], references: [id])
  userId          String                              // denormalized for fast tenant filtering
  senderId        String
  sender          Sender      @relation(fields: [senderId], references: [id])
  toEmail         String
  toName          String?
  vars            Json?                               // CSV columns for merge tags
  subject         String                              // rendered
  body            String                              // rendered
  sequence        Int                                 // order within campaign (ordering guarantee)
  scheduledAt     DateTime                            // original intended time
  nextAttemptAt   DateTime                            // may move forward on rate-limit
  status          EmailStatus @default(SCHEDULED)
  attempts        Int         @default(0)
  rateLimitedCount Int        @default(0)
  messageId       String?     @unique                 // deterministic: <emailId@reachinbox.local>
  previewUrl      String?                             // Ethereal preview
  sentAt          DateTime?
  failedAt        DateTime?
  lastError       String?
  lockedAt        DateTime?                           // set when status -> SENDING
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
  @@unique([campaignId, toEmail])                     // dedupe leads per campaign
  @@index([userId, status, nextAttemptAt])
  @@index([userId, status, sentAt])
}

model RateLimitEvent {            // audit + analytics + Slack dedupe trail
  id         String   @id @default(cuid())
  senderId   String
  scope      String               // "sender" | "global" | "campaign"
  windowKey  String               // e.g. 2026-09-29T14
  hitAt      DateTime @default(now())
  notified   Boolean  @default(false)
  @@unique([senderId, scope, windowKey])
}

enum EmailStatus   { SCHEDULED RATE_LIMITED SENDING SENT FAILED CANCELLED }
enum CampaignStatus{ ACTIVE PAUSED CANCELLED COMPLETED }
enum SenderStrategy{ ROUND_ROBIN FIXED }
```

**Email state machine (the only legal transitions):**

```
SCHEDULED ──► SENDING ──► SENT
    │  ▲         │
    │  │         └──► FAILED (after max attempts) ──(manual retry)──► SCHEDULED
    ▼  │
RATE_LIMITED (moved to later window, back to SCHEDULED semantics)
    │
any non-terminal ──► CANCELLED (user cancel/pause)
```

The UI's "Scheduled" tab shows `SCHEDULED | RATE_LIMITED | SENDING`. The "Sent" tab shows `SENT | FAILED`.

---

## 5. Scheduling Core (Agent A4): how it works

### 5.1 Scheduling a campaign (`POST /api/campaigns`)
1. Validate with the zod schema from `packages/shared` (subject, body, leads[], startAt ≥ now − 60s, delayBetweenMs ≥ 0, hourlyLimit ≥ 1, senderIds?).
2. Dedupe and validate the leads (lowercase, RFC-ish regex, unique). Return `{ accepted, invalid[], duplicates }`.
3. Compute each email's time: **`scheduledAt_i = startAt + i × delayBetweenMs`**. This is the user's campaign-level spacing.
4. Assign a sender: round-robin across the chosen active senders (`sender = senders[i % n]`).
5. Render merge tags (`{{name}}`, `{{company}}`, `{{email}}`, …) from the CSV columns (extra feature F2).
6. In **one DB transaction**, `createMany` the Campaign and its Emails (chunks of 1000).
7. **After commit**, `emailQueue.addBulk()` in chunks of 500:
   ```ts
   { name: 'send', data: { emailId }, opts: {
       jobId: emailId,                         // ← queue-level idempotency
       delay: Math.max(0, scheduledAt - Date.now()),
       attempts: env.EMAIL_MAX_ATTEMPTS,       // default 3
       backoff: { type: 'exponential', delay: 30_000 },
       removeOnComplete: { age: 7 * 24 * 3600 },
       removeOnFail: false,
   }}
   ```
8. Enqueue ES index jobs for the batch. Broadcast an SSE `campaign.created` event.

> If the process dies between step 6 and step 7, the **reconciler** (§5.5) enqueues the orphaned rows on the next boot. That is the outbox-lite pattern.

The job payload carries **only `emailId`**. The DB is the truth, so jobs never hold stale data.

### 5.2 Worker pipeline (`email.worker.ts`)
`new Worker(EMAIL_QUEUE, processor, { concurrency: env.WORKER_CONCURRENCY, connection, lockDuration: 60_000 })`

```
processor(job, token):
  1. email = db.findUnique(emailId); if missing or status ∈ {SENT, CANCELLED} → return (ack, no-op)
  2. if campaign PAUSED/CANCELLED → return (the pause path already removed jobs; defensive)
  3. QUOTA CHECK (atomic Lua, §6.2) for [global, sender, campaign]
       → if denied: compute nextWindowSlot; db.status = RATE_LIMITED, nextAttemptAt = slot;
         emit rate-limit event → notifyQueue.add(dedupe); job.moveToDelayed(slot, token);
         throw new DelayedError()                        ← BullMQ-native, NOT a failure
  4. SLOT RESERVATION (atomic Lua, §6.1) per sender → returns slotTs
       → if slotTs > now + 50ms: refund quota; job.moveToDelayed(slotTs, token); throw DelayedError
  5. CLAIM: UPDATE email SET status='SENDING', lockedAt=now(), attempts=attempts+1
            WHERE id=$1 AND status IN ('SCHEDULED','RATE_LIMITED')     ← DB-level idempotency
       → 0 rows updated ⇒ another worker owns it or it's already done → return
  6. SEND via pooled nodemailer transport for that sender,
       headers: Message-ID = <emailId@reachinbox.local>  (deterministic)
  7. UPDATE status='SENT', sentAt, messageId, previewUrl = nodemailer.getTestMessageUrl(info)
  8. indexQueue.add, SSE `email.sent`
  on SMTP error: UPDATE status = (attemptsMade+1 < max ? 'SCHEDULED' : 'FAILED'), lastError; rethrow
                  → BullMQ backoff retry; the final failure is visible in the Sent tab as `failed`
```

### 5.3 Concurrency safety
- Multiple jobs run in parallel (`WORKER_CONCURRENCY`, default 5) and multiple worker processes can run too.
- **Nothing shared lives in JS memory.** Quotas and slots use Redis Lua (atomic). Ownership uses a conditional DB `UPDATE … WHERE status IN (…)`.
- SMTP transports are pooled per sender (`pool: true, maxConnections: 2`). They are a per-process cache only, not state.

### 5.4 Idempotency: three layers
| Layer | Mechanism | Protects against |
|---|---|---|
| Queue | `jobId = emailId`. BullMQ ignores a duplicate add with the same id. | Double enqueue (reconciler plus original, double-click on Schedule) |
| DB | Conditional claim `SCHEDULED → SENDING` (row count check), `@@unique(campaignId,toEmail)`, `messageId @unique` | Two workers picking up the same email, stalled-job re-delivery |
| Request | `Idempotency-Key` header on `POST /api/campaigns` (stored in Redis for 24h → returns the same response) | Frontend retry or double submit |

**Crash window (documented trade-off):** if the worker dies *after* the SMTP accept but *before* `status=SENT`, the row stays `SENDING`. The reconciler marks `SENDING` rows older than `STALE_SENDING_MS` (default 5 min) as **FAILED with reason `interrupted_possible_duplicate_prevented`** instead of re-sending. We choose **at-most-once** delivery, which is the correct bias for cold email: a duplicate cold email hurts sender reputation more than a missed one. The user can retry manually from the UI.

### 5.5 Persistence and restart recovery
1. **Redis AOF**: `redis-server --appendonly yes --appendfsync everysec` plus a named volume. Delayed jobs live in the `bull:email:delayed` ZSET and survive a restart.
2. **Postgres** is the durable source of truth.
3. **Boot reconciler** (`recovery/reconciler.ts`) runs once when the worker starts. It is not periodic, so it is not cron:
   - `SCHEDULED | RATE_LIMITED` rows whose job is missing from Redis (`queue.getJob(id) == null`) → re-add with the same jobId and `delay = max(0, nextAttemptAt - now)`. This also covers the case where Redis was wiped.
   - Stale `SENDING` → FAILED per §5.4.
   - Past-due emails (the server was down *at* send time) are sent ASAP. They still pass the rate limiter, so a burst after a long outage stays throttled.
4. BullMQ's **stalled-job detection** re-delivers jobs whose worker died mid-process. The DB claim makes that safe.
5. **Graceful shutdown**: on `SIGTERM`/`SIGINT`, call `worker.close()` (finish in-flight jobs), then close Redis, Prisma and the SMTP pools.

**Restart demo (scripted, `scripts/restart-demo.sh`):** schedule 10 emails 1 min apart → wait for 2 sent → `kill` the api and worker → wait 2 min → start again → show that the missed ones send immediately (throttled), future ones go out on time, and none are duplicated (count Message-IDs in the Ethereal inbox).

### 5.6 Queues
| Queue | Purpose | Concurrency |
|---|---|---|
| `email-send` | the core | `WORKER_CONCURRENCY` |
| `notifications` | Slack messages (keeps SMTP workers free of Slack latency) | 2 |
| `search-index` | ES upserts with retry (ES being down never blocks sending) | 5 |

All three show up in Bull Board at `/admin/queues`.

---

## 6. Throttling: Delay, Hourly Limits, Load (Agent A5)

### 6.1 Minimum delay between sends (per sender)
- Env: `MIN_DELAY_BETWEEN_EMAILS_MS=2000` → **"minimum 2 seconds between any two emails from the same sender."**
- Redis key `throttle:slot:{senderId}` holds the next free timestamp. Lua, atomic:
  ```lua
  -- KEYS[1]=slot key, ARGV[1]=now, ARGV[2]=minDelay
  local nextFree = tonumber(redis.call('GET', KEYS[1]) or '0')
  local slot = math.max(tonumber(ARGV[1]), nextFree)
  redis.call('SET', KEYS[1], slot + tonumber(ARGV[2]), 'PX', 3600000)
  return slot
  ```
- If `slot > now`, the job moves to delayed until `slot`. This is safe across N workers and N instances.
- **Dispatch gate (strictness):** slots are reserved exactly `minDelay` apart, but a job that wakes a few ms late would squeeze the gap to the next on-time job (we measured 1.97 s). So right before SMTP an atomic `gate` Lua checks `throttle:last:{senderId}`: dispatch only if `now ≥ lastDispatch + minDelay`, else re-delay (keeping the reserved quota ticket). Measured on Ethereal: min real gap **2.007 s**. Spacing is measured at dispatch (`Email.dispatchedAt`), not `sentAt`, since SMTP latency (1–5 s on Ethereal) varies.
- There are two independent layers: the **campaign stagger** (`delayBetweenMs` from the UI, the user's intent) and the **provider throttle** (env, a system guarantee). The effective gap is `max(both)`.
- *Why not the BullMQ `limiter`?* It is **queue-global**, not per sender, and it can't express "per hour per sender with rollover". We mention it in the README as the simpler alternative we considered.

### 6.2 Emails per hour (Redis counters, fixed UTC hour windows)
- Env: `MAX_EMAILS_PER_HOUR=200` (global), `MAX_EMAILS_PER_HOUR_PER_SENDER=50`. The campaign's own `hourlyLimit` comes from the form.
- Keys: `rl:global:{YYYYMMDDHH}`, `rl:sender:{senderId}:{YYYYMMDDHH}`, `rl:campaign:{campaignId}:{YYYYMMDDHH}`, each with a TTL of 2h.
- One Lua script checks all three and increments **all or none** (no partial consumption):
  ```lua
  -- KEYS = {global, sender, campaign}; ARGV = {limG, limS, limC, ttl}
  for i=1,3 do
    local c = tonumber(redis.call('GET', KEYS[i]) or '0')
    if c >= tonumber(ARGV[i]) then return i end        -- which scope blocked
  end
  for i=1,3 do redis.call('INCR', KEYS[i]); redis.call('EXPIRE', KEYS[i], ARGV[4]) end
  return 0
  ```
- On a successful SMTP send the count stays. On SMTP failure we **refund** (DECR) so failures don't eat quota. That trade-off is documented.

### 6.3 When the limit is hit: reschedule, preserve order
- `nextWindowStart = startOfNextUtcHour(now)`
- Order preservation: `rank = INCR rl:overflow:{scope-key}:{nextWindow}` → `slot = nextWindowStart + rank × MIN_DELAY_BETWEEN_EMAILS_MS`. Jobs that overflowed earlier get earlier slots in the next hour, so FIFO is kept "as much as possible", which is what the brief allows. Emails also carry `sequence`, and the job `priority` is not used, to keep BullMQ semantics simple.
- DB: `status = RATE_LIMITED`, `nextAttemptAt = slot`, `rateLimitedCount++` → the UI shows an amber **"Rate limited → 15:00"** badge.
- **Never fail, never drop**: we use `job.moveToDelayed` + `DelayedError`, which doesn't consume `attempts`.

### 6.4 Slack trigger
- On a quota denial, `SET slack:notified:{scope}:{id}:{window} 1 NX EX 7200`. Only the **first** denial per sender per window enqueues a Slack notification ("the moment it's reached"). The DB `RateLimitEvent` row is the audit trail.

### 6.5 Behaviour under load (README section; numbers use the defaults)
**Scenario:** 1,000 emails, 1 campaign, 4 senders, all at 10:00, per-sender limit 50/h, global limit 200/h, min delay 2 s.

- Insert: 1 transaction (~1 s). `addBulk` in 2 chunks of 500.
- 10:00: all 1,000 jobs become due. With 5 workers pulling concurrently, each sender's slot reservation spaces sends 2 s apart. That gives 4 senders × 1 send per 2 s = **2 emails/s** in aggregate.
- After 50 per sender (~100 s) each sender's hourly limit trips → **4 Slack messages** (one per sender) → the remaining 800 move into the 11:00, 12:00, … windows in order.
- Drain time ≈ 1,000 / 200 per hour = **5 hours**, fully deterministic and visible in Bull Board as delayed jobs.
- Redis memory ≈ 1,000 × ~1 KB ≈ 1 MB. Trivial.
- Demo mode: `.env.demo` sets `MAX_EMAILS_PER_HOUR_PER_SENDER=5` and `RATE_WINDOW_SECONDS=120`. Windows are configurable in length, so a reviewer can watch a rollover in 2 minutes instead of 1 hour. Production default: 3600.

`scripts/load-test.ts` hits the real API with 1,000 generated leads and prints a timeline table (status counts every 5 s).

---

## 7. Integrations (Agent A6)

### 7.1 Ethereal senders
- `npm run senders:create -w @ri/api -- --count 3` → calls `nodemailer.createTestAccount()` 3× and upserts the `Sender` rows (passwords encrypted). It prints the Ethereal login URLs so the reviewer can open the inbox.
- The Sent-tab row links to `previewUrl` (the Ethereal message viewer).

### 7.2 Elasticsearch
- Index `emails-v1` (alias `emails`). Mapping: `toEmail` (keyword + text), `subject` (text + keyword), `body` (text), `status` (keyword), `userId` (keyword), `campaignId`, `senderEmail` (keyword), `scheduledAt`/`sentAt` (date).
- Writes: `search-index` queue job `{ emailId }` → read the DB row → `index` (upsert by id). It is **idempotent by construction**. Bulk on campaign create.
- Reads: `GET /api/emails/search?q=&status=&from=&to=&page=`. Uses `multi_match` over toEmail^3, subject^2, body; filters by `userId` (tenant isolation!); highlights.
- The ES index gets created on boot if missing. `npm run reindex -w @ri/api` rebuilds it from Postgres (the DB is the source of truth).
- If ES is down, sending is unaffected: index jobs retry with backoff.

### 7.3 Slack (real OAuth v2)
1. Create a Slack App at api.slack.com → **Scopes:** `incoming-webhook`, `chat:write` → Redirect URL `https://<tunnel>/api/slack/oauth/callback`.
2. `GET /api/slack/connect` (auth required) → generate `state` = signed JWT(userId, nonce, 10 min) → redirect to `https://slack.com/oauth/v2/authorize?client_id…&scope=incoming-webhook,chat:write&state…&redirect_uri…`
3. Callback → verify `state` → `POST https://slack.com/api/oauth.v2.access` → store `incoming_webhook.url`, channel, team and `access_token` **encrypted** (AES-256-GCM, key from `ENCRYPTION_KEY`) in `SlackConnection` → redirect to `/settings?slack=connected`.
4. `POST /api/slack/test` → sends "✅ ReachInbox connected" (a live proof button in the UI).
5. `DELETE /api/slack` → `auth.revoke` (best effort) + delete the row. Reconnect repeats the flow.
6. **Notifier** (`notify.worker.ts`): looks up the connection **at send time**. If there's no connection it logs `slack.skipped` and returns success (no crash). If there's a connection it posts a Block Kit message:
   > 🚦 **Hourly limit reached**, sender `alice@ethereal.email` (50/50 this hour). 312 emails deferred to 15:00 UTC. [Open dashboard] [Open queue]
7. Webhook 404/410 (revoked on the Slack side) → mark the connection `invalid`, the UI shows a "Reconnect" banner.

"Tenant" = the logged-in user who owns the campaign. The rate-limit event is routed to the owner of the campaign whose job tripped it. For the global and sender scopes, it goes to every user with pending jobs on that sender, still deduped per user.

---

## 8. Auth (Agent A3)

- Google Cloud Console → OAuth client (Web) → authorized redirect `http://localhost:4000/api/auth/google/callback`. Scopes: `openid email profile`.
- `GET /api/auth/google` → Passport → callback → upsert User (googleId, name, email, picture) → sign a JWT (`sub`, 7d) → `Set-Cookie: ri_session=…; HttpOnly; SameSite=Lax; Secure(in prod)` → redirect `WEB_URL/dashboard`.
- `GET /api/auth/me` → `{ id, name, email, avatarUrl, slackConnected }`.
- `POST /api/auth/logout` → clear the cookie.
- `requireAuth` middleware on every `/api/*` route except auth, and on `/admin/queues`.
- CORS: `origin: WEB_URL, credentials: true`. (Or a Vite proxy in dev, so it's same-origin with no CORS pain. **Chosen: Vite proxy `/api` → 4000.**)
- Tenant isolation: **every** query filters by `userId`. An integration test asserts that user B can't see user A's emails via the list or search endpoints.

---

## 9. Frontend (Agents A7 UI and A8 Data)

### 9.0 Figma (⚠️ ACTION FOR HUMAN)
The Figma file returned *"no access"* to the Figma tool, and its canvas didn't render in the automation browser.
**Anushka: open the Figma link, export each frame (Login, Dashboard-Scheduled, Dashboard-Sent, Compose, any modal/empty state) as PNG into `design/`**, and note any colors, fonts or spacing from Dev Mode into `design/tokens.md`. A7 then builds against those pixel references.

Until then A7 builds from this **expected layout** (the typical structure of this assignment's design, *to be verified against Figma*):
- **Login:** centered card, logo, "Login with Google" button (Google G icon), clean white/grey background, green brand accent.
- **Dashboard:** **left sidebar** (logo, user avatar/name/email block with a dropdown for Logout, a big **Compose** button, nav: *Scheduled* (count), *Sent* (count)), plus a **main panel** with a search bar, filter/refresh icons, and a list of rows: recipient `To: email`, status chip (`Scheduled` grey/orange, `Sent` green, `Failed` red) with time, subject (bold) plus body snippet, star icon.
- **Compose (full page):** back arrow, "Compose New Email" title, fields: **From** (sender dropdown), **To** (chip input + **Upload List** button showing "N emails detected"), **Subject**, **Delay between 2 emails** (seconds), **Hourly Limit**, a rich-ish body editor with a toolbar, and a **Send Later** button → popover with date-time picker and quick picks ("Tomorrow", "Tomorrow 10 AM", …) → **Schedule**.
- **Email detail:** clicking a row opens the full email view (subject, from/to, date, body).

**Design tokens** (update after the Figma export): `--brand: #0B9A5B-ish green`, neutral greys, Inter font, 8 px radius, 1 px `#E5E7EB` borders.

### 9.1 Pages and routes
| Route | Page | Notes |
|---|---|---|
| `/login` | LoginPage | redirects to `/dashboard` if authed |
| `/dashboard` → `/dashboard/scheduled` | ScheduledPage | default tab |
| `/dashboard/sent` | SentPage | |
| `/dashboard/email/:id` | EmailDetail (drawer or page) | Ethereal preview link, timeline of status changes |
| `/compose` | ComposePage (or modal per Figma) | |
| `/settings` | SettingsPage | Connect/Disconnect Slack, sender quotas |
| `/analytics` | AnalyticsPage | extra feature |
| `*` | NotFound | |

`<ProtectedRoute>` uses `useAuth()` (`GET /api/auth/me` via React Query). If unauthenticated it goes to `/login`.

### 9.2 Reusable components (DRY contract)
- `ui/`: `Button` (variants primary/secondary/ghost/danger, sizes, `loading`), `Input`, `Textarea`, `Select`, `Modal`, `Drawer`, `Tabs`, `Badge`, `Avatar` (falls back to initials), `Skeleton`, `Spinner`, `EmptyState` (icon, title, description, action), `Dropzone`, `DateTimePicker`, `Tooltip`, `Toaster`.
- `email/EmailTable`: **one** generic table, configured by `columns` and `variant: 'scheduled' | 'sent'`. Scheduled and Sent pages are thin wrappers around it, which is the DRY proof.
- `email/StatusBadge`: a single mapping `EmailStatus → {label, color}` in `packages/shared`.

### 9.3 Data layer (A8)
- `api/client.ts`: a typed `fetch` wrapper (`credentials: 'include'`) that parses errors into a `ApiError {status, code, message}` and validates responses with the zod schemas from `packages/shared`.
- React Query keys: `['me']`, `['emails', status, page, q]`, `['senders']`, `['analytics', range]`, `['slack']`.
- `useLiveEvents()`: an `EventSource('/api/events')` → on `email.*` events, `queryClient.invalidateQueries(['emails'])` (throttled to 1/s) → tables update live.
- Cursor pagination (`?cursor=&limit=50`) so 1,000+ rows stay smooth.

### 9.4 Compose flow detail
1. Upload `.csv` or `.txt` → `papaparse` (header detection: an `email` column, or any cell that matches an email regex; `.txt` is split on newlines, commas and semicolons).
2. Show **"✅ 1,024 emails detected · 12 invalid · 8 duplicates removed"** plus a 5-row preview and the detected merge columns (`{{name}}`, `{{company}}`).
3. Fields: Subject*, Body*, Start time* (default now + 5 min), Delay between emails (s) *, Hourly limit *, Sender(s).
4. Live **"Estimated finish: today 16:40"** computed from count, delay and hourly limit (extra feature, cheap and impressive).
5. Schedule → `POST /api/campaigns` with an `Idempotency-Key` (uuid generated once per form mount) → toast → navigate to `/dashboard/scheduled`.
6. Validation errors inline (react-hook-form + the shared zod schema), and server errors as a toast.

### 9.5 UX states (explicitly required)
Every data view has **Skeleton rows while loading**, an **EmptyState** ("No scheduled emails yet" plus a Compose CTA / "Nothing sent yet"), and an **Error state** with Retry. Mutations show button spinners and toasts.

---

## 10. API Contract (frozen after Phase 1; changes go through A0)

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/api/auth/google` | – | 302 Google |
| GET | `/api/auth/google/callback` | – | 302 `WEB_URL/dashboard` + cookie |
| GET | `/api/auth/me` | – | `User` |
| POST | `/api/auth/logout` | – | 204 |
| POST | `/api/campaigns` | `CreateCampaignInput` + `Idempotency-Key` | `{campaignId, accepted, invalid[], duplicates, estimatedFinishAt}` |
| GET | `/api/campaigns` | – | `Campaign[]` with counts |
| POST | `/api/campaigns/:id/pause` / `resume` / `cancel` | – | `Campaign` |
| GET | `/api/emails` | `status=scheduled|sent&cursor&limit` | `{items: EmailRow[], nextCursor}` |
| GET | `/api/emails/search` | `q,status,page` | `{items, total, highlights}` (ES) |
| GET | `/api/emails/:id` | – | `EmailDetail` (incl. previewUrl, history) |
| POST | `/api/emails/:id/retry` | – | `EmailRow` (FAILED → SCHEDULED, new job with id `${emailId}:r${n}`) |
| GET | `/api/emails/counts` | – | `{scheduled, sent, failed}` for sidebar badges |
| GET | `/api/senders` | – | `Sender[]` with `usedThisHour/limit` |
| GET | `/api/analytics/hourly` | `range=24h` | `[{hour, sent, failed, rateLimited}]` |
| GET | `/api/slack` | – | `{connected, teamName, channelName}` |
| GET | `/api/slack/connect` | – | 302 Slack |
| GET | `/api/slack/oauth/callback` | `code,state` | 302 `/settings?slack=connected` |
| POST | `/api/slack/test` | – | 204 |
| DELETE | `/api/slack` | – | 204 |
| GET | `/api/events` | – | SSE stream (per-user filtered) |
| GET | `/admin/queues` | – | Bull Board UI |
| GET | `/healthz` | – | `{db, redis, es}` |

Errors are always `{ error: { code, message, details? } }`.

---

## 11. Additional Features (beyond the brief, **8 planned, 5 minimum**)

Built **only after Phase 3 is green**. Ranked by impressiveness ÷ effort:

| ID | Feature | Why a ReachInbox reviewer will care | Effort |
|---|---|---|---|
| **F1** | **Real-time dashboard** (SSE): rows flip Scheduled → Sending → Sent live, sidebar counters tick | Mirrors their "live analytics"; makes the demo video pop | S |
| **F2** | **Merge-tag personalization** `{{name}}`, `{{company}}` from CSV columns + live preview of the first lead | Their core pitch is "hyper-personalized" | S |
| **F3** | **Campaign controls**: Pause / Resume / Cancel (removes or re-adds delayed jobs), per-row Cancel | Real operational need; shows queue mastery (`job.remove`) | M |
| **F4** | **Analytics page**: sent/failed/rate-limited per hour (recharts), per-sender quota meters ("Health"-style bars: 42/50 this hour) | Mirrors their analytics + Health Score | M |
| **F5** | **Email detail drawer + Ethereal preview link + status timeline** (scheduled → rate-limited → sent) | Makes "not duplicated" verifiable in 1 click | S |
| **F6** | **Retry failed** (manual, one-click) + automatic exponential backoff, with attempts visible | Reliability story | S |
| **F7** | **Smart ETA & CSV hygiene**: estimated finish time, invalid/duplicate report, sender round-robin | Echoes their "Smart Time Gaps" and verification | S |
| **F8** | **Load-test + restart-demo scripts** and a **CI "no-cron" guard** | Directly de-risks the elimination criteria | S |
| F9 *(stretch)* | Dark mode toggle | Polish | S |
| F10 *(stretch)* | Keyboard shortcuts (`c` compose, `/` search, `g s` sent), inspired by their Onebox | Delight | S |
| F11 *(stretch)* | Timezone-aware scheduling (the user's tz shown, UTC stored) | Correctness polish | S |

The README gets a section **"Beyond the brief"** listing these with screenshots.

---

### 11.1 Demo-visible features (what the video should show)

Ranked by on-screen impact. Backend depth is proven in the README/tests; the video sells what is *visible*.

| # | Feature | What the viewer sees | Status |
|---|---|---|---|
| 1 | Live dashboard (SSE) | Rows flip Scheduled → Sending → Sent and counters tick with no refresh; toast on limit hit | ✅ |
| 2 | Search with highlights (Elasticsearch) | Type "acme" → instant results, matches highlighted, "10 results · 6 ms · Elasticsearch"; typo → "approximate results" | ✅ |
| 3 | Slack settings card | Connect Slack → Slack consent → "Posting to #alerts" → Send test message → appears in Slack | ✅ (live run needs creds) |
| 4 | Rate-limit badge with resume time | Amber "Rate limited · Resumes 9:27 PM" + "Paused" when campaign paused | ✅ |
| 5 | Email detail drawer | Full email, Ethereal button, status timeline | ✅ |
| 6 | Analytics page | Tiles, stacked hourly chart (+ table view), live quota meters | ✅ |
| 7 | Campaign controls | Campaigns page with progress bars; Pause / Resume / Cancel | ✅ |
| 8 | Retry failed | Retry in the drawer → Scheduled → Sent, timeline shows it | ✅ |
| 9 | Merge-tag personalisation | Click {{name}}/{{company}} chips from CSV columns; personalised sends | ✅ |
| 10 | Upload report + ETA | "1,024 detected · 12 invalid · 8 duplicates" + "Est. finish 16:40" | ✅ |
| 11 | System health pill | "Live" pulse; DB/Redis/Search/Live dots; link to Bull Board | ✅ |
| 12 | Dark mode + shortcuts | Theme toggle; `c` compose, `/` search (`/` ✅) | ⬜ stretch |

## 12. Quality Gates

### 12.1 Tests (A9)
**Unit (Vitest):**
- `windows.ts`: hour boundaries, DST-free UTC, configurable window length
- `rateLimiter`: all-or-none increment, which-scope-blocked, refund, overflow rank ordering (real Redis)
- `reserve_slot`: 20 concurrent reservations → strictly spaced by minDelay
- CSV parser: headers, no headers, txt, junk, dupes
- merge-tag renderer: missing vars → empty string, no code injection

**Integration (Supertest + real PG/Redis):**
- Create campaign → N rows + N delayed jobs with jobId = emailId
- Duplicate `addBulk` → still N jobs
- **Concurrency:** 2 workers × concurrency 10, 50 emails due now → exactly 50 SMTP calls (mock transport), 0 duplicates
- **Rate limit:** limit 5 → 5 sent, rest `RATE_LIMITED` with ordered `nextAttemptAt`; Slack mock called exactly once
- **No Slack connection** → rate-limit hit → no throw
- **Restart:** enqueue → close the worker → delete the job from Redis (simulating a wipe) → reconciler → job restored, sent once
- Stale SENDING → FAILED, not resent
- Tenant isolation on list and search
- Auth: unauthenticated → 401 on every protected route

### 12.2 Definition of Done (per task)
Typechecks · lint clean · tests for the logic · no hardcoded config · error paths handled · Progress Board updated.

### 12.3 Env (`.env.example`, every var documented)
```
# server
API_PORT=4000
WEB_URL=http://localhost:5173
API_URL=http://localhost:4000
JWT_SECRET=
ENCRYPTION_KEY=            # 32-byte base64, AES-256-GCM
# infra
DATABASE_URL=postgresql://ri:ri@localhost:5434/reachinbox
REDIS_URL=redis://localhost:6380
ELASTICSEARCH_URL=http://localhost:9200
# google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# slack
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_REDIRECT_URI=https://<tunnel>/api/slack/oauth/callback
# scheduler
WORKER_CONCURRENCY=5
MIN_DELAY_BETWEEN_EMAILS_MS=2000
MAX_EMAILS_PER_HOUR=200
MAX_EMAILS_PER_HOUR_PER_SENDER=50
RATE_WINDOW_SECONDS=3600
EMAIL_MAX_ATTEMPTS=3
STALE_SENDING_MS=300000
```

### 12.4 CI guard (no cron, ever)
```bash
! grep -RInE "node-cron|agenda|cron\(|crontab|setInterval\(" apps/api/src --include=*.ts --exclude-dir=events
```
(`setInterval` is banned in backend src. The only exception is the SSE keep-alive ping in `modules/events/`, which is excluded above and never schedules anything.)

---

## 13. Demo Video Script (≤ 5:00), owned by A10

| Time | Shot |
|---|---|
| 0:00–0:20 | Title + architecture diagram (one slide) |
| 0:20–0:45 | Google login → header shows name, email, avatar → logout → login again |
| 0:45–1:40 | Compose: upload CSV → "1,000 detected" → merge tags preview → start in 1 min, delay 2s, hourly 10 → Schedule → Scheduled tab fills (skeleton → rows) |
| 1:40–2:10 | Bull Board: delayed jobs; Elasticsearch search bar finds an email by subject |
| 2:10–2:50 | Emails flip to Sent live (SSE) → click one → Ethereal preview opens |
| 2:50–3:40 | **Rate limit:** sender hits 10/window → **Slack message arrives live** on screen → rows show "Rate limited → next window" in order |
| 3:40–4:35 | **Restart:** `Ctrl-C` api + worker → wait → restart → the reconciler log → future emails still send on time → Message-ID count shows zero duplicates |
| 4:35–5:00 | Disconnect Slack → next limit hit → no message, no crash → wrap-up |

Use `.env.demo` (short windows) so everything fits in 5 minutes. **Record twice**: once as a dry run, once for real.

---

## 14. Agents, Phases & Progress Board

### 14.1 Agent roster (each agent owns folders, and touching another's folder requires a note in §15)

| ID | Agent | Owns | Core deliverables |
|---|---|---|---|
| **A0** | **Architect / Orchestrator** | `GODFATHER.md`, `packages/shared`, API contract | Freezes contracts, reviews every merge, resolves conflicts, runs phase gates |
| **A1** | **Infra & DevOps** | `docker-compose.yml`, `.env.example`, root configs, CI | PG/Redis(AOF)/ES up with one command, npm workspaces, tsconfig/prettier, CI with the no-cron guard |
| **A2** | **Backend Foundation** | `apps/api/src/{app,server,config,lib}` | Express skeleton, zod env, error middleware, pino, healthz, graceful shutdown |
| **A3** | **Data & Auth** | `prisma/`, `modules/auth` | Schema + migrations + seed, Google OAuth, JWT cookie, requireAuth, tenant scoping |
| **A4** | **Scheduler Core** | `queues/`, `recovery/`, `mail/`, `modules/{campaigns,emails}` | Enqueue, worker pipeline, idempotency, reconciler, Bull Board, SSE events |
| **A5** | **Throttle Engineer** | `throttle/` | Lua scripts, rate limiter, slot reservation, overflow ordering, load math, `.env.demo` |
| **A6** | **Integrations** | `modules/{slack,search,senders}`, `scripts/create-ethereal-senders.ts` | Ethereal sender pool, Slack OAuth + notifier, ES index + search API |
| **A7** | **Frontend UI** | `apps/web/src/{components,pages,styles}` | Figma-faithful UI kit, layouts, all pages, states |
| **A8** | **Frontend Data** | `apps/web/src/{api,hooks,app}` | Typed client, React Query hooks, auth guard, SSE hook, CSV hook |
| **A9** | **QA & Load** | `apps/api/test`, `scripts/{load-test,restart-demo}` | Test suites in §12.1, load and restart scripts, bug reports to owners |
| **A10** | **Docs & Demo** | `README.md`, `docs/`, video script | README meeting every brief bullet, architecture diagram, trade-offs, video |

### 14.2 Phases, dependencies and gates

```
Phase 0  ─► Phase 1 ─► Phase 2 ─┬─► Phase 3 ─► Phase 4 ─► Phase 5 ─► Phase 6
Recon      Skeleton    Core      │   Integr.    Extras     Harden     Ship
                        Frontend ┘ (parallel from Phase 1 on mocked contract)
```

---

#### **PHASE 0: Recon & Contracts** (Day 0, ~3h), agents: A0 + Human
- [ ] Human: export Figma frames → `design/` + `design/tokens.md`
- [ ] Human: create the Google OAuth client, the Slack app, and install `cloudflared`
- [x] A0: freeze the Prisma schema (§4), API contract (§10) and shared zod types (`apps/api/prisma/schema.prisma`, migration `init` applied)
- [x] A0: write `packages/shared` (types + schemas + STATUS_META map)

**Gate G0:** the contract is committed and the shared package builds.

#### **PHASE 1: Skeleton** (Day 1), agents: A1, A2, A3 in parallel; A7 + A8 start the UI kit against mocks
- [x] A1: npm-workspaces monorepo, tsconfig strict, prettier, docker-compose (PG :5434, Redis AOF :6380, ES :9200), `.env.example`, CI (`.github/workflows/ci.yml`) + `npm run check:no-cron`. *ESLint deferred to Phase 5.*
- [x] A2: Express app, env validation, error handler, logger, `/healthz`, graceful shutdown, two entry points (`server.ts`, `worker.ts`)
- [x] A3: Prisma migrate, Google OAuth (state-cookie CSRF), `/me`, logout, requireAuth, tenant-scoped `GET /api/emails` + `/counts`. *Real Google login is untested until credentials exist; seeding moves to the Phase 2 senders script.*
- [x] A7: Tailwind v4 tokens, UI kit (Button, Input/Textarea, Badge, Avatar, Skeleton, Spinner, EmptyState, Modal, Menu), LoginPage, DashboardLayout, shared EmailTable (Scheduled/Sent)
- [x] A8: typed api client (zod-validated), `useAuth`/`useLogout`, ProtectedRoute, router, `useEmails` (infinite/cursor). *No MSW needed: the real `/api/emails` already exists.*

**Gate G1:** `docker compose up` → login with Google → the dashboard shows the real name, email and avatar → logout works.

#### **PHASE 2: Scheduler Core** (Days 2–3), agents: A4, A5, A6 (senders), A9 starts tests
- [x] A6: `npm run senders:create -w @ri/api -- --count 3` (encrypted creds) + pooled nodemailer transport, deterministic Message-ID. 3 real Ethereal senders registered.
- [x] A4: `POST /api/campaigns` (validate, lead normalisation/dedupe, merge tags, stagger, round-robin, tx, addBulk with jobId, Idempotency-Key, ETA)
- [x] A4: worker pipeline §5.2 with DB claim and deterministic Message-ID (`queues/emailProcessor.ts`)
- [x] A5: one atomic Lua `acquire` (slot + 3-scope quota, all-or-none) + `gate` (strict dispatch spacing) + `refund` + overflow ordering (`throttle/rateLimiter.ts`), 10 unit tests
- [x] A4: integrate the throttle into the worker (`moveToDelayed` + `DelayedError`; ticket persisted on the job)
- [x] A4: boot reconciler + stale-SENDING handling (self-healing via delayed re-check) + graceful shutdown (in-flight sends finish; pino flushed)
- [x] A4: Bull Board at `/admin/queues` (auth)
- [x] A4: `GET /api/emails` (scheduled/sent, cursor), `/counts`, `/:id` (owner-only, 404 otherwise)
- [x] A9: integration tests: concurrency (2 workers × 10), idempotency (queue/DB/request), rate-limit FIFO + single notify, strict min-delay, restart reconcile, stale SENDING, SMTP failure → FAILED. **35/35 green, 3 consecutive runs.**

**Gate G2 (the elimination gate):** via Postman, schedule 20 emails → they send on time through Ethereal → kill both processes mid-run → restart → the remainder send, **0 duplicates** → limit 5/window → the rest roll into the next window in order. Every test is green.

#### **PHASE 2b: Frontend core** (Days 2–3, parallel), agents: A7, A8
- [x] ComposePage: From (all senders round-robin, or one, with live quota), CSV/TXT upload (drag & drop, in-browser parse, “N emails detected”, invalid/duplicate report, preview), subject, body with click-to-insert `{{merge_tags}}` from CSV columns, start time + quick picks, delay, hourly limit, summary with ETA, Schedule
- [x] Scheduled & Sent pages on the shared `EmailTable` with loading, empty and error states; auto-refresh every 5 s (until SSE in F1)
- [x] Toasts (success with server ETA), inline validation (client zod + server `fieldErrors` mapped onto fields), Idempotency-Key per compose session
- [x] Real API throughout (no mocks were needed); new `GET /api/senders`

**Gate G2b:** the full UI flow works against the real backend and matches the Figma screenshots side by side.

#### **PHASE 3: Required integrations** (Day 4), agents: A6, A7, A8
- [x] A6: Slack OAuth v2 connect/callback/disconnect/test, encrypted storage (signed `state` carries the user through the tunnel; `auth.revoke` on disconnect)
- [x] A6: notifications queue + worker (Block Kit message) + dedupe per sender-window + no-connection no-op + dead webhook → `isValid=false` → UI asks to reconnect; transient errors retry
- [x] A6: ES index (alias `emails` → `emails-v1`, email-part analyzer), index worker fed by every status change + campaign create, `/api/emails/search` (precise prefix first, fuzzy fallback flagged `approximate`, highlights, tenant filter, fresh rows from PG), `npm run reindex -w @ri/api`
- [x] A7/A8: SettingsPage (not-configured / connect / connected / needs-reconnect states, Test, Disconnect, OAuth result toasts), SearchBar (`/` shortcut, URL `?q=`, highlights, result count + ES latency)

**Gate G3:** a live Slack message arrives when the limit is hit. Disconnect → no crash. Reconnect → it works again without restarting. Search finds emails by recipient, subject and body. **At this point every R1–R26 row in §1 is ✅.**

#### **PHASE 4: Beyond the brief** (Day 5), only if G3 is green
- [x] F1 SSE live updates: worker/API → Redis pub/sub (per-user channel) → `/api/events` → coalesced refetch; in-app rate-limit toast; "Live" pill; polling drops to 30 s while connected
- [x] F2 merge tags (click-to-insert chips from CSV columns; rendered per lead) — done in 2b
- [x] F3 Campaigns page: segmented progress, derived Completed, Pause / Resume / Cancel (confirm modal) + per-email cancel; pause survives window rollover, resume re-adds same jobIds in order
- [x] F4 Analytics: 5 stat tiles, stacked hourly chart (palette validated by dataviz checker; legend + tooltip + table view), live per-sender quota meters
- [x] F5 detail drawer (`?email=` in URL): full email, Message-ID, dispatch/sent times, Ethereal button, timeline from new `EmailEvent` log
- [x] F6 Retry failed (drawer button): FAILED → SCHEDULED, same jobId replaced; verified on a real interrupted email
- [x] F7 ETA + CSV hygiene report — done in 2b
- [x] F8 `npm run demo -w @ri/api -- load | restart | verify <id>` + CI no-cron guard

**Gate G4:** at least 5 of F1–F8 are demoable.

#### **PHASE 5: Hardening** (Day 6), agents: A9 lead, everyone fixes
- [x] 1,000-email load run captured in `docs/VERIFICATION.md` (`npm run demo -w @ri/api -- load`)
- [x] Restart drills: worker SIGKILL (35 sent/0 dup; 5 in-flight → FAILED, never resent), API SIGKILL (worker kept sending 30/30), Redis container restart (AOF kept 56 delayed jobs; 60/60, 0 dup), graceful SIGTERM (0 left SENDING)
- [x] Two workers × concurrency 5: split 40/20, 60/60, 0 duplicates, min per-sender gap 500 ms across processes
- [x] Security pass: S1 OAuth codes redacted from logs, S2 JWT alg pinned, S3 `ADMIN_EMAILS` for Bull Board, S4 Redis request throttling (429), S5 no internal errors in prod; deps → `npm audit` 0 (nodemailer 10, react-router 7, deepmerge-ts 8, vitest 5); 6 security tests
- [x] a11y: axe-core WCAG 2.1 AA → 0 violations on all 7 views (fixed brand/muted contrast tokens, removed nested scroll region); 375 px no overflow. *Figma polish still blocked on export.*
- [x] ESLint (flat config) clean; typecheck/test/no-cron green; `npm run setup` one-command bootstrap; fresh-clone test found & fixed missing Prisma generate in postinstall; CI now has Elasticsearch, lint and audit

**Gate G5:** a fresh clone → README steps → running in under 10 minutes on a clean machine.

#### **PHASE 6: Ship** (Day 7), agents: A10 + Human
- [x] README complete (mirrors the brief 1:1), Mermaid architecture, trade-offs, 8 real screenshots (`docs/screenshots/`), `docs/VERIFICATION.md`, `docs/DEMO_SCRIPT.md`; `demo reset` for clean recordings; production build start verified
- [ ] Record the demo per §13 (≤ 5:00), upload (unlisted YouTube/Loom), link it in the README
- [ ] Human: create the **private** GitHub repo, push, and **invite `Mitrajit` and `Yadav036`**
- [ ] Human: final checklist: §1 matrix all ✅, video plays, repo access confirmed

### 14.3 Progress Board (update on every merge)

| Phase | Status | Owner(s) | Gate | Notes |
|---|---|---|---|---|
| 0 Recon & Contracts | 🟨 Code ✅ · Human items pending | A0, Human | G0 ✅ (contracts) | Figma export + Google/Slack credentials still needed |
| 1 Skeleton | ✅ Built & verified (2026-09-29) | A1 A2 A3 A7 A8 | G1 🟨 | 12/12 API tests, typecheck, web build, no-cron all green. Guard/login/logout/dashboard checked in the browser with a dev session. **G1 closes once GOOGLE_CLIENT_ID/SECRET are in `.env`** |
| 2 Scheduler Core | ✅ Done (2026-09-29) | A4 A5 A6 A9 | **G2 ✅** | Verified on real Ethereal SMTP (demo limits: 60 s window, 4/sender, 2 s): 20-email campaign survived a hard kill mid-run → remaining 11 sent after restart, reconciler found all jobs intact; 2 rows interrupted mid-SMTP → FAILED `interrupted_before_confirmation`, never re-sent; 30-email burst → never >4/sender/window, rolled into later windows in order; 1 rate-limit event per sender per window; real dispatch gap min **2.007 s**; **75 SENT / 75 distinct Message-IDs**. Graceful SIGTERM: in-flight sends finished, 0 rows left SENDING. |
| 2b Frontend Core | ✅ Done (2026-09-29) | A7 A8 | G2b 🟨 | Full UI flow verified in the browser on real SMTP: CSV (10 valid, 1 invalid, 1 duplicate) → schedule → rows staggered 2 s across 3 senders → table drained to Sent automatically; merge tags rendered per lead. Mobile: no horizontal overflow. 37 API + 5 web tests. **Figma side-by-side still pending the frame export.** |
| 3 Integrations | 🟨 Built & tested; live Slack pending creds | A6 A7 A8 | G3 🟨 | Search ✅ live: 5–14 ms in ES, new emails searchable in <3 s and move tabs when sent. Slack: 11 tests over the real routes with Slack's HTTP API mocked (OAuth, encrypted storage, notify, no-op when disconnected, dead webhook, reconnect, revoke). **G3 closes after one live run with the Slack app + cloudflared.** 56 API + 5 web tests green. |
| 4 Extras | ✅ Done (2026-09-29) | all | **G4 ✅ (8/8)** | Verified live in demo mode: 30-email campaign → rows/counters updated with no refresh, 3 rate-limit toasts, amber “Resumes 9:27 PM” badges; pause held across a window rollover, resume finished 30/30 with 30 distinct Message-IDs; timeline SCHEDULED→RATE_LIMITED×2→PAUSED→RESUMED→SENT. Load demo: 1,000 due at once → 0 dropped, exactly 4/sender/60 s, min gap 2,034 ms, 0 dups; cancel of 976 took 0.18 s. 66 API + 5 web tests. |
| 5 Hardening | ✅ Done (2026-09-29) | A9 + all | **G5 ✅** | Fresh copy → `npm ci` → `npm run setup` → 77 tests → build, in minutes. Evidence in `docs/VERIFICATION.md`. |
| 6 Ship | 🟨 Docs done; human steps left | A10, Human | — | Remaining: Google + Slack creds → live check, Figma pass, record video, private repo + invites |

Legend: ⬜ not started · 🟨 in progress · ✅ done · 🟥 blocked

### 14.4 Agent handoff protocol
1. **Start:** read §0, §1, your lane, and §15. Set your phase row to 🟨.
2. **Work:** stay in your folders. Need a contract change? Write a §15 entry and ping A0. Don't edit it yourself.
3. **Finish:** tick your checkboxes, add a one-line note (what, where, how to verify), and run the gate check if you're the last one in the phase.
4. **Blocked:** set 🟥 plus the reason. A0 re-plans.

---

## 15. Decision Log & Change Requests
| Date | Decision | Why | By |
|---|---|---|---|
| 2026-09-29 | Vite React over Next.js | Backend owns OAuth/session; no SSR needed; faster build | A0 |
| 2026-09-29 | Postgres + Prisma | Typed, migrations, reviewers are familiar with it | A0 |
| 2026-09-29 | Per-sender Redis slot + fixed-window counters over the BullMQ limiter | Limiter is queue-global; brief wants per-sender and rollover | A0 |
| 2026-09-29 | At-most-once on the crash window | Duplicate cold emails hurt reputation more than a missed one | A0 |
| 2026-09-29 | Separate API and worker processes | Proves restart and multi-instance safety | A0 |
| 2026-09-29 | Configurable window length (`RATE_WINDOW_SECONDS`) | Makes hourly rollover demoable in < 5 min | A0 |
| 2026-09-29 | npm workspaces instead of pnpm | pnpm/corepack not installed on the dev machine; npm 11 is enough | A1 |
| 2026-09-29 | Host ports PG 5434, Redis 6380 | 5432/6379/5433 already used by other local services and containers | A1 |
| 2026-09-29 | `API_PORT` instead of `PORT` | Tooling (preview runner/PaaS) injects `PORT` for the web server and would hijack the API | A2 |
| 2026-09-29 | Prisma pinned to 6.x, zod 3.x, Express 4 | Prisma 7 changes the client and generator setup; avoid churn during an elimination round | A0 |
| 2026-09-29 | `scripts/dev-session.ts` (dev only, refuses in prod) | Lets the UI be exercised before Google credentials exist | A3 |
| 2026-09-29 | Single `acquire` Lua (slot + global/sender/campaign quota) instead of two scripts | One round trip, and all-or-none: a blocked email burns neither quota nor a slot | A5 |
| 2026-09-29 | Throttle "ticket" `{slot, window}` stored on the job (`job.updateData`) | Reservation survives restarts and avoids a thundering herd of re-checks; an expired ticket is refunded | A4/A5 |
| 2026-09-29 | Strict dispatch gate + `Email.dispatchedAt` | Brief says *minimum* delay; wake-up jitter made real gaps 1.97 s without it | A5 |
| 2026-09-29 | Stale `SENDING` rows are re-checked by delaying the job until `lockedAt + STALE_SENDING_MS` | Self-healing without cron, and without waiting for the next worker boot | A4 |
| 2026-09-29 | Email ids are UUIDs | BullMQ custom job ids can't contain `:` or be integers; UUIDs are safe and pre-generated before enqueue | A4 |
| 2026-09-29 | `fileParallelism: false` in Vitest; tests use random BullMQ/Redis prefixes | Suites share one DB/Redis with a running dev worker; isolation over speed | A9 |
| 2026-09-29 | ES documents rebuilt from Postgres on every change (index queue); search returns ids+highlights, rows read from PG | Idempotent, order-independent indexing; results always show current status despite ES being eventually consistent | A6 |
| 2026-09-29 | Search: precise (bool_prefix) first, fuzzy only as fallback, flagged `approximate` | One combined query let "load1" fuzzy-match every "load" (31 noisy hits); two-phase keeps typos working without noise | A6 |
| 2026-09-29 | Highlights use \u0001/\u0002 markers rendered as text, not HTML | No `dangerouslySetInnerHTML` → user content can't inject markup | A7 |
| 2026-09-29 | Slack callback is public; a signed 10-min `state` JWT identifies the user | The callback arrives via the HTTPS tunnel domain, where the localhost session cookie isn't sent | A6 |
| 2026-09-29 | Phase 4 started while G3's live Slack run waits on credentials | Only the external credential step is open; extras don't touch Slack | A0 |
| 2026-09-29 | `EmailEvent` append-only log (+ synthesised history for older rows) | Timeline and deferral analytics need history; rows alone only hold current state | A4 |
| 2026-09-29 | Live updates via Redis pub/sub → SSE (not WebSockets) | One-way server→browser is all we need; SSE auto-reconnects, works through the Vite proxy, one subscriber per API instance | A4/A8 |
| 2026-09-29 | Pause removes jobs; processor also skips PAUSED campaigns; resume re-adds same jobIds by sequence | Nothing sends while paused even if a job is mid-flight; order preserved. Trade-off: a reserved-but-unused throttle ticket is not refunded on pause (tiny under-use of that window) | A4 |
| 2026-09-29 | Chart colours from the dataviz validator (#0b9a5b / #e0a100 / #b42318) | First pick failed the normal-vision floor (red vs amber ΔE 14.4); amber's low contrast relieved by text legend + table view | A7 |
| 2026-09-29 | `npm run dev:demo` loads `.env.demo.example` over `.env` | One command for the video's 60 s windows; real env vars win over the .env file | A1 |
| 2026-09-29 | Analytics page lazy-loaded | recharts pushed the main bundle over 500 kB; now split (main 472 kB) | A7 |
| 2026-09-29 | ESLint flat config at root (typescript-eslint + react-hooks) | One config for 3 workspaces; `consistent-type-imports`, no `any` | A1 |
| 2026-09-29 | Upgraded nodemailer 6→10, react-router 6→7, vitest 2→5; deepmerge-ts pinned to 8 via `overrides` | Audit findings incl. nodemailer cross-transport TLS/credential leak (we run one transport per sender). v7 router was drop-in after removing future flags | A1 |
| 2026-09-29 | Request throttling is separate from the email limiter and fails open | Abuse protection must never take the API down if Redis blips | A2 |
| 2026-09-29 | `ADMIN_EMAILS` optional; empty = any signed-in user | Keeps local dev frictionless; production can restrict Bull Board | A3 |
| 2026-09-29 | Contrast tokens: primary buttons brand-600 (#08844d, 4.75:1), brand text brand-700, muted #5f6b7c | axe: brand-500 with white text was 3.62:1; muted on canvas 4.47:1 | A7 |
| 2026-09-29 | Native page scroll + sticky sidebar/header (no `<main overflow-auto>`) | axe `scrollable-region-focusable`; also nicer on mobile | A7 |
| 2026-09-29 | Root `postinstall` also runs `prisma generate` | Fresh clone failed: Prisma's own postinstall looks for a schema at repo root, ours is in apps/api | A1 |
| 2026-09-29 | `npm run setup` (idempotent) | Reviewers get from clone to running in one command | A1 |
| 2026-09-30 | Spam check, spintax and send jitter live in `@ri/shared` as pure functions | Same code runs in the browser (live) and the API (validation, rendering); easy to test | A4/A7 |
| 2026-09-30 | Spintax seeded by recipient address; resolved before merge tags | Preview, test send and real send agree; retries never change wording; lead data can't inject spintax | A4/A7 |
| 2026-09-30 | Jitter varies campaign gaps (mean preserved), seeded by the lead list | Forecast matches the real schedule; the limiter's per-sender minimum is untouched | A4/A7 |
| 2026-09-30 | Offline (rule-based) assistant "Ask Inbox" first; LLM mode deferred | No API key needed for reviewers; deterministic, cannot invent numbers; same tools/confirm flow can back an LLM later | A4/A7 |
| 2026-09-30 | Every assistant change is proposed → Confirm → executed once (Redis GETDEL) → audited (`AssistantAction`) | Human-in-the-loop; single-use tokens namespaced per user; stale state re-checked at confirm | A4 |
| 2026-09-30 | Assistant UI = Cmd+K palette + docked side panel sharing one history | Quick asks and long conversations; the panel pushes content at ≥1280px, overlays below, full-screen on phones | A7 |
| 2026-09-30 | Theme tokens: raw `--c-*` per theme → Tailwind names via `@theme inline`; `data-theme` on `<html>` set pre-paint | One switch re-themes everything incl. charts (CSS vars); no flash; `System` follows the OS | A7 |
| 2026-09-30 | Dark theme = deep-indigo "space" backdrop (aurora + twinkling stars, static under reduced-motion), frosted-glass surfaces, violet accent for the assistant | Matches the product's feel; popovers/dialogs stay opaque for legibility | A7 |
| 2026-09-30 | Dark chart palette #1db06a / #c28610 / #e0506f | Only combination that passed the dataviz validator's lightness band, colour-blind and distinguishability checks in dark | A7 |
| 2026-09-30 | Pages lay out by container width (`@container`), not viewport | The assistant panel takes 400px; grids must respond to the space they actually get | A7 |
| 2026-09-29 | Slack notifier reads the connection at send time; 403/404/410/`no_service` → mark invalid, other errors → retry | Connect/disconnect/reconnect work without redeploy; revoked webhooks don't retry forever | A6 |

---

## 16. README Outline (A10 fills it; mirrors the brief's submission list 1:1)
1. Overview + screenshot + demo video link
2. Quick start: `docker compose up -d` → `npm install` → `npm run db:migrate` → `npm run senders:create -w @ri/api` → `npm run dev` (api + worker + web)
3. Env setup: Google OAuth, Slack app + tunnel, Ethereal (auto-created), every var explained
4. **Architecture**: Mermaid diagram (Web → API → PG/Redis/ES; Worker ↔ Redis/SMTP/Slack)
   - How scheduling works (§5.1–5.2)
   - How persistence on restart is handled (§5.5)
   - How rate limiting and concurrency are implemented (§6), including the **"min 2 seconds between sends per sender"** statement and the 1000-email walkthrough
5. Feature map: Backend (scheduler, persistence, rate limiting, concurrency, Slack, ES, Bull Board) · Frontend (login, dashboard, compose, tables, states) · Beyond the brief (F1–F8)
6. API reference (§10)
7. Testing: how to run, what is covered, load and restart scripts
8. **Assumptions, shortcuts & trade-offs** (at-most-once, fixed windows vs sliding, UTC windows, tenant = user, ES eventual consistency, Ethereal doesn't deliver for real, tunnel needed for Slack)

---

## 17. Risk Register
| Risk | Impact | Mitigation |
|---|---|---|
| Slack OAuth needs HTTPS | Blocks R13 | `cloudflared tunnel --url http://localhost:4000`; document it; set it up on Day 0 |
| Google OAuth consent screen in "Testing" mode | Reviewers can't log in on a deployed URL | Add reviewers as test users *or* note that it runs locally; the demo video covers it |
| ES heavy on RAM | Laptop struggles | `ES_JAVA_OPTS=-Xms512m -Xmx512m`, single node, security off |
| Ethereal rate limits / flakiness | Failed sends in the demo | 3 senders, retries with backoff, demo with small volumes |
| Figma access blocked | UI mismatch → elimination | Human exports the frames on Day 0 (§9.0) |
| Clock skew between workers | Early or late sends | Use Redis `TIME` inside Lua for the window/slot "now" |
| Scope creep from extras | Core not finished | **Phase 4 is locked until G3 is green** |
