# Stage 9: hardening report

Date: 2026-10-27. Scope: the API, the web app and the shared design tokens as merged up to Stage 8 (PR #8). This is an internal review with automated tests for every fix. It is **not** an independent penetration test; that needs an outside firm and a staging environment (Stage 10).

Summary:

| Area | Found | Fixed in this stage | Left open |
| --- | --- | --- | --- |
| Security review | 7 issues (3 high, 3 medium, 1 low) | All 7, each with a test | 7 lower-priority items, listed below |
| Load tests | The feed took 4 to 7 seconds for people who follow few accounts | Feed query rewritten: 44 ms at the median | Multi-instance and long-running soak tests need staging |
| Accessibility audit (web) | 6 kinds of axe failure on 4 of 17 screens, plus no skip link and focus rings missing on links | All of them; the audit now runs in CI | Flutter app not audited; tabs lack arrow-key support |

## How to rerun everything

```bash
pnpm --filter @nexa/api test                                    # includes test/hardening.e2e.spec.ts
pnpm --filter @nexa/api build && pnpm --filter @nexa/web build
E2E_ONLY=a11y pnpm --filter @nexa/web test:e2e                  # accessibility, keyboard and CSP checks
createdb -O superapp superapp_load && node apps/api/load/run.mjs   # load tests (LOAD_ONLY=feed etc.)
pnpm audit                                                       # known vulnerabilities in dependencies
```

The load tests are not in CI: they take about four minutes and their numbers depend on the machine.

## Security review

Method: read every controller and the services behind them for authentication, authorisation, input handling, SQL, rate limits and secrets; read the web server layer (proxy, middleware, cookies, headers); checked dependencies with `pnpm audit`. Each finding below has a regression test.

### Fixed

| # | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| 1 | High | **Known vulnerabilities in dependencies.** `pnpm audit` reported 31 (10 high): Fastify 5.11.3 (an authentication bypass through malformed URLs, request-validation bypasses, a crash on malformed HTTP, `X-Forwarded-*` spoofing), Nodemailer 7 (SMTP command injection, header injection, quadratic-time parsing), and PostCSS under Next.js (file read, path traversal). | Fastify 5.12.7, Nodemailer 10.2.1, PostCSS 8.5.32. Fastify and PostCSS are pinned with `overrides` in `pnpm-workspace.yaml` because NestJS 11 and Next.js pin older ones; drop those lines when the parents catch up. `pnpm audit` now reports none. | `pnpm audit`; the full API and web suites pass on the new versions |
| 2 | High | **Anyone could choose their own IP address on the web app**, and so dodge the per-IP limits on sign-in, sign-up and password reset. The web server passed the *first* `X-Forwarded-For` entry to the API, and that entry is whatever the client sent. | The web server takes the entry its own proxy added: set `WEB_PROXY_HOPS` to the number of proxies in front of it (`apps/web/lib/client-address.ts`). Never expose the Next.js server directly. | `apps/web/test/client-address.test.mjs` |
| 3 | High | **The same on the API** (`docs/risks.md` #12). `TRUST_PROXY=true` trusts every hop, so behind a load balancer a phone could send its own `X-Forwarded-For` and pick its address. | `TRUST_PROXY` now takes the proxies' addresses (`10.0.0.0/8,192.168.1.4`, or `loopback`, `uniquelocal`); only those peers may set the header. `TRUST_PROXY=true` is refused in staging and production. A hop count is refused too, because Fastify 5.12 can't check the peer with one. | `hardening.e2e.spec.ts` "client addresses", `unit.spec.ts` config |
| 4 | Medium | **Passwords could be guessed from inside a session.** Changing the password, turning off two-step, deactivating and deleting all check the password with no limit, so someone holding a stolen session could guess it and lock the owner out. | 10 attempts per 15 minutes per account, shared across those endpoints. | `hardening.e2e.spec.ts` "re-entering the password" |
| 5 | Medium | **Two-step codes could be guessed faster than intended.** The limit was 5 tries per challenge, but anyone with the password could ask for a new challenge each time (10 per 15 minutes), so 50 guesses per 15 minutes. | A second limit of 10 codes per 15 minutes per account, across challenges. | `hardening.e2e.spec.ts` "two-step codes" |
| 6 | Medium | **No Content Security Policy or HSTS on the web app.** One injection bug would have let a script run with the user's session. | A per-request CSP with a nonce (`apps/web/middleware.ts`): only scripts Next.js rendered run, no inline handlers, no plugins, no framing, `base-uri 'none'`, forms only to this site, network only to this site, the API's WebSocket and the media storage (`CSP_MEDIA_ORIGINS`). HSTS for two years in production. | Web e2e "Content Security Policy"; every other e2e flow (chat, uploads, calls, payments, push) runs under the policy |
| 7 | Low | **No cap on WebSockets per person**, so one account could hold hundreds open (tickets allow 30 a minute). Account export, which reads every table, had no limit either. | 20 sockets per person per API instance (`429` beyond that); 5 exports per hour. | `realtime.e2e.spec.ts` "caps the sockets", `hardening.e2e.spec.ts` "account export" |

### Checked and fine

- SQL: every query is parameterised. The few built from strings use column names from fixed maps or values validated by zod (which drops unknown keys), and `LIKE` patterns escape `%`, `_` and `\`.
- Authorisation: every controller except auth, health and the Stripe webhook is behind `AuthGuard`, which checks the session in the database on each request. Hidden things return 404. Admin routes also check the staff role, two-step and session age.
- Tokens: refresh rotation with reuse detection, one-time tokens hashed, TOTP replay blocked, webhook signatures compared in constant time within a tolerance window.
- Web proxy: the allow-list can't be escaped with `..` or encoded slashes (every segment pattern excludes `.` and `/`), and cross-site writes are refused.
- Uploads: allow-listed types, server-chosen keys, size and signature checked after upload; downloads re-check access.
- Push: Web Push URLs only to known push services, so the API can't be aimed at internal hosts.

### Left open

| Item | Why it isn't fixed here |
| --- | --- |
| Independent penetration test | Needs an outside firm and a staging environment (Stage 10). |
| Sign-up says when an email is already registered | A deliberate trade-off for a clear sign-up form; limited by the per-IP sign-up limit. Revisit with CAPTCHA or device attestation (`risks.md` #6). |
| `style-src 'unsafe-inline'` in the CSP | React writes `style` attributes (progress bars, video tiles). Inline styles can't run script; moving them to classes is cleanup, not a fix. |
| ~~Retired refresh tokens and used one-time tokens are never deleted~~ | Fixed: the retention sweep deletes ended sessions (with their retired tokens) after 90 days and spent one-time tokens after 7. |
| Secret manager and key rotation | Stage 10 (`security-privacy.md`). |
| Breached-password check, CAPTCHA on sign-up | Already tracked in `risks.md` #6. |
| NestJS 12 | Would remove the Fastify override; a major upgrade, so separate. |

## Load tests

`apps/api/load/run.mjs` starts the built API against real Postgres and Redis, seeds data straight into the database, and drives it over HTTP and WebSockets. Rate limits are off, because this measures capacity.

Machine: one cloud container with 4 vCPUs and 15 GB of memory running the API (one Node process, database pool of 20), Postgres 16, Redis 7 and the load generator together. A real deployment separates these, so treat the numbers as a floor and as a before-and-after comparison, not as production capacity.

### Results

| Scenario | Result |
| --- | --- |
| Fan-out, direct chat: 40 messages, 5 a second | Delivered to the other person in 10 ms at the median, 14 ms p95 |
| Fan-out, group of 50 | 15 ms median, 21 ms p95 to every member; all 1,960 deliveries arrived |
| Fan-out, group of 256 (the maximum) | 15 ms median, 26 ms p95 to every member; all 10,200 deliveries arrived |
| Throughput: 100 direct chats sending as fast as acks come back, 20 s | 650 to 710 messages a second across runs; acks 151 ms median, 190 ms p95; every event delivered, no errors |
| Presence: 1,000 sockets connecting 100 at a time | About 840 connections a second, 101 ms median, 138 ms p95; 271 MB resident for the API; all 500 offline events delivered |
| Feed, 100,000 posts, 20 readers refreshing back to back, following 150 people | **Before:** 217 ms median, 313 ms p95 (90 requests a second). **After:** 79 ms median, 123 ms p95 (248 a second) |
| Feed, same, following 5 people | **Before: 4.4 s median, 6.7 s p95** (5 requests a second). **After:** 44 ms median, 65 ms p95 (448 a second) |

Numbers are from the last run on 2026-10-27; repeated runs on this machine vary by about 10%. Rerun `run.mjs` after anything touching these paths.

### What changed: the feed

The feed was built by walking all posts newest-first and checking each against "is it mine, by someone I follow, or in my community, and may I see it" until a page was full. With few follows in a large table that means scanning almost everything. It now reads each source through its own index (your posts, each person you follow, each of your communities), takes at most a page from each, and merges them, applying the visibility rules inside each source so a page is never short. Every post is still checked by `can_view_post` before it is returned. A test checks full pages, ordering and de-duplication when a followed person's newest posts are hidden (`hardening.e2e.spec.ts` "feed").

This is still fan-out on read. Someone following thousands of accounts reads one index entry per account per page, which is fine at today's scale; fan-out on write (a timeline per person) is the next step if that grows.

### What it says about the rest

- **Messaging fan-out is not the bottleneck** at today's group sizes. The per-conversation row lock (`risks.md` #7) costs little up to 256 members: a message reaches all 255 others in about the same time as one person.
- **Write throughput is bound by the database pool**: 100 busy senders on a pool of 20 queue for connections, which is what the 150 ms acks show. Raise `DATABASE_POOL_MAX` or add instances before raising group sizes or adding bots.
- **Not measured yet:** several API instances sharing Redis pub/sub, long soak runs (memory over hours), and Postgres on its own machine. These need staging (Stage 10).

## Accessibility audit (web)

Method: axe-core 4.11 with the WCAG 2.0, 2.1 and 2.2 A and AA rules plus axe's best practices, run in Chromium on 17 screens with real data on them (signed out, a customer, and an admin with two-step), in light and in dark mode. Plus keyboard checks: a skip link as the first stop, and a visible focus ring on every control. The audit is `a11yFlow` in `apps/web/e2e/run.mjs`, part of the CI e2e run, and fails on any violation.

### Found and fixed

| Problem | WCAG | Where | Fix |
| --- | --- | --- | --- |
| Red text too faint (4.07:1 on grey) | 1.4.3 | Delete and reject buttons, errors | Danger colour `#D6336C` → `#C2255C` (4.99:1 or better) in the design tokens, so the Flutter app gets it too |
| White text on your own chat bubbles too faint in dark mode (4.32:1), and the time under them (3.15:1) | 1.4.3 | Chats | Own bubble `#4C6EF5` → `#3B5BDB` in dark mode (5.67:1); message times at 90% opacity instead of 75% |
| No skip link; keyboard users tabbed through the whole menu on every page | 2.4.1 | Every screen | "Skip to content" link as the first stop, moving focus to the content |
| Focus ring only on inputs and buttons | 2.4.7 | Links, tabs, row buttons | One `:focus-visible` ring for every control |
| No main landmark or page heading on chats; no page heading on the feed | 1.3.1, 2.4.6 | Chats, feed | `<main>` and an `<h1>` (visible "Chats"; screen-reader-only "Feed") |
| Headings skipped a level | 1.3.1 | Business back office | Tab section headings are `h2` under the page's `h1` |
| Report rows in the admin queue were tiny touch targets | 2.5.8 | Admin dashboard | Rows keep their padding (about 46 px tall) |

### Not covered

- **The Flutter app** has not been audited. That needs TalkBack and VoiceOver on real devices, together with the device testing still open from Stage 6. The colour fixes reach it through the shared tokens.
- **Automated checks find roughly a third of accessibility problems.** A manual pass with a screen reader (NVDA or VoiceOver) through sign-up, chatting, ordering and the admin queue is still to do.
- **Tabs** (business back office, admin) work with Tab and Enter but not the arrow keys of the ARIA tabs pattern.
- Calls: captions and a text alternative for call audio are not available.
