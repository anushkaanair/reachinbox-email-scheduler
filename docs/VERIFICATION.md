# Verification log

Evidence for the claims in the README. Everything below was run against the real stack
(Postgres, Redis with AOF, Elasticsearch, **real Ethereal SMTP**) on 2026-09-29, not mocks.
Re-run any of it yourself with the commands shown.

## Automated checks

| Check                                                                 | Command                                                                 | Result                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Unit + integration tests (real PG/Redis/ES, SMTP & Slack HTTP mocked) | `npm test`                                                              | **277 passed** (263 API + 14 web) |
| Types (strict)                                                        | `npm run typecheck`                                                     | 0 errors                          |
| Lint                                                                  | `npm run lint`                                                          | clean                             |
| No cron anywhere (hard constraint)                                    | `npm run check:no-cron`                                                 | passed                            |
| Dependency audit (prod + dev)                                         | `npm audit`                                                             | **0 vulnerabilities**             |
| Accessibility (axe-core, WCAG 2.1 A/AA)                               | all 7 pages × light and dark, plus the Ask Inbox palette and panel open | **0 violations**                  |
| Fresh clone → running                                                 | copy without `node_modules` → `npm ci` → `npm run setup` → test → build | passes end to end                 |

## Restart & resilience drills

Config for drills: 100/sender per 60 s window, ≥ 500 ms between sends, concurrency 5.
Duplicates are measured as `sent rows − distinct Message-IDs` (Message-IDs are deterministic per email).

| Drill                    | What we did                                                                           | Result                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Worker hard crash** | 40 emails due; `kill -9` the worker mid-send; API kept serving (200s); restart worker | Reconciler: all 25 pending jobs still in Redis (0 re-queued). **35 sent, 0 duplicates**, min gap 502 ms. The 5 emails in-flight at the kill → `FAILED · interrupted_before_confirmation` after the stale lock expired — **never re-sent** (at-most-once, by design). |
| **B. API crash**         | 30 emails; `kill -9` the API mid-send                                                 | Worker kept sending with the API down: **30/30 sent**, 0 duplicates, min gap 501 ms.                                                                                                                                                                                 |
| **C. Redis restart**     | 60 emails (1/s); `docker restart` Redis mid-run                                       | 56 delayed jobs before → still there after (AOF). Worker logged 4 connection errors, reconnected by itself. **60/60 sent, 0 duplicates.**                                                                                                                            |
| **D. Two workers**       | 2 worker processes × concurrency 5, 60 emails due at once                             | Work split **40 / 20**; **60/60 sent, 0 duplicates**, min per-sender gap **500 ms** across processes.                                                                                                                                                                |
| **Graceful stop**        | `SIGTERM` the worker mid-run                                                          | In-flight sends finished, queues/SMTP/DB closed in order, **0 rows left SENDING**.                                                                                                                                                                                   |

## Rate limiting under load

```
npm run dev:demo                                 # 60 s windows, 4/sender, ≥ 2 s between sends
npm run demo -w @ri/api -- load --count 1000
```

```
    time  scheduled  rate-limited  sending   sent  failed
21:31:28       1000             0        0      0       0
21:31:31        809           188        3      0       0
21:31:37          6           988        3      3       0
21:31:43          0           988        0     12       0
21:32:04          3           979        0     18       0
21:32:10          0           976        0     24       0

Duplicates: 0  (sent 24, distinct Message-IDs 24)
Min gap between sends of one sender: 2034 ms (configured 2000 ms)
Per sender per 60s window (limit 4):
  16:01:00  m4imrqiw6hybk4wc@ethereal.email    4
  16:01:00  xzhkbh6iy7yazfjf@ethereal.email    4
  16:01:00  yglnddkswzghczkc@ethereal.email    4
  16:02:00  m4imrqiw6hybk4wc@ethereal.email    4
  …
```

1,000 emails due at once → none dropped or failed; exactly the configured 4/sender/window; the rest wait
as `RATE_LIMITED` in their original order, and a Slack/in-app alert fires once per sender per window.

## Security review (Phase 5)

| #    | Finding                                                                                                                                                                       | Fix                                                                | Test                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| S1   | Request logs recorded OAuth `?code=&state=` in plaintext                                                                                                                      | Redacting request serializer                                       | `security.test.ts`               |
| S2   | JWT verify didn't pin the algorithm                                                                                                                                           | `algorithms: ['HS256']` (session + Slack state)                    | forged `alg:none` token → 401    |
| S3   | Any signed-in user could use Bull Board's retry/delete on everyone's jobs                                                                                                     | Optional `ADMIN_EMAILS` allowlist                                  | 403 for non-admin, 200 for admin |
| S4   | No throttling on login / campaign creation                                                                                                                                    | Redis fixed-window limits → 429 + `Retry-After`                    | 21st request → 429               |
| S5   | Search 503 leaked internal error text                                                                                                                                         | Details only outside production                                    | —                                |
| Deps | nodemailer ≤10.0.1 (incl. _cross-tenant SMTP credential disclosure_ across transports — relevant: one transport per sender), react-router open redirect, deepmerge-ts, vitest | nodemailer 10, react-router 7, deepmerge-ts 8 (override), vitest 5 | `npm audit` → 0                  |

Already in place: httpOnly + SameSite=Lax session cookie (blocks cross-site POSTs), AES-256-GCM for SMTP
passwords and Slack tokens, tenant scoping on every query (tests for list, detail, search, controls, SSE),
Slack OAuth `state` signed and expiring, search highlights rendered as text (no HTML injection), helmet headers.
