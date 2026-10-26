# Architecture

## Starting point

The repository held only a one-line `README.md` when this work began. It had no code, dependencies or infrastructure, so nothing needed to be kept or migrated. Everything here was written from scratch. The working environment had Node 22, Postgres 16 and Redis 7. Flutter 3.47.8 was installed for this work. There was no Docker daemon, so `infra/docker-compose.yml` has not been run here (CI and developer machines can run it).

## Shape

```
 Flutter app (iOS/Android) ──HTTPS/JSON + WebSocket──┐
                                                      ├──> API (NestJS on Fastify) ──> PostgreSQL 16
 Browser ──> Next.js web (server layer) ──────────────┘           │                ──> Redis 7 (rate limits, presence, pub/sub fan-out)
   │          holds tokens in httpOnly cookies                    └──> SMTP provider (Mailpit locally)
   ├── WebSocket to the API with a one-time ticket
   └── presigned PUT/GET ──> S3-compatible object storage (SeaweedFS locally) <── API signs URLs, checks uploads
```

There is one modular backend, not microservices. Modules have clear boundaries (their own tables and services) so that a module can be split out later if load or team size calls for it. The modules are:

| Module | Status | Owns |
| --- | --- | --- |
| identity (`auth`, `users`) | Built | users, sessions, one-time tokens, privacy settings, MFA |
| safety | Built (user side) | blocks, reports |
| audit | Built | append-only `audit_log` |
| messaging | Built (1:1; not E2EE) | conversations, members, messages, reactions, hides, receipts, change feed |
| media | Built (no scanning yet) | object-storage keys, upload state, access checks |
| realtime | Built | WebSocket gateway, tickets, presence, Redis fan-out (`docs/realtime.md`) |
| notifications | Stage 4 | device push tokens, delivery queue |
| social | Stage 5 | posts, stories, follows, communities |
| calls | Stage 6 | call signalling, call history (media goes over WebRTC/TURN/SFU) |
| business | Stage 7 | businesses, staff roles, catalogues, orders |
| payments | Stage 8 | provider intents, webhooks, ledger, refunds, settlement |
| subscriptions | Stage 8 | plans, entitlements, provider receipts |
| admin | Stage 7 to 9 | separate app with its own RBAC, staff MFA, audit |

## Key decisions

These are written up as ADRs in `docs/adr/`:

1. [Monorepo and stack](adr/0001-monorepo-and-stack.md): pnpm workspaces, NestJS 11 with Fastify, Next.js 15, Flutter, Postgres, Redis.
2. [Sessions and tokens](adr/0002-sessions-and-tokens.md): short-lived JWTs, rotating opaque refresh tokens, and a session check on every request.
3. [Database access and migrations](adr/0003-database-and-migrations.md): plain SQL with `pg`, and forward-only checksummed migrations.
4. [End-to-end encryption](adr/0004-end-to-end-encryption.md): the Signal protocol through libsignal, with MLS assessed for large groups. Not built yet; Stage 3 chats are server-readable.
5. [Payments boundary](adr/0005-payments-boundary.md): licensed providers only, no stored funds and no P2P until a legal review.
6. [Mini-app platform](adr/0006-mini-apps.md): an approved integrations catalogue first, and a sandboxed runtime only after a security review.

## Versions (pinned)

| Component | Version |
| --- | --- |
| Node.js | 22 LTS |
| NestJS | 11.2.8 (`@nestjs/platform-fastify`, Fastify 5.11.3) |
| PostgreSQL | 16 |
| Redis | 7 |
| Next.js / React | 15.5.28 / 19.1.10 |
| Flutter | 3.47.8 stable |
| TypeScript | 5.9.3 |
| ws (WebSocket server) | 8.21.2 |
| AWS SDK for JavaScript (S3) | 3.1140.0 |
| SeaweedFS (local and CI object storage) | 3.97 |
| web_socket_channel (Flutter) | 3.0.3 |

Newer majors were available (NestJS 12, Next 16). We chose the most recent majors with a long track record. Upgrading later is routine work.

## Cross-cutting

- **Config:** environment variables are validated with zod at boot. The app refuses to start with weak or missing secrets. It also refuses test-only switches (in-memory mail, disabled rate limits) in staging and production.
- **Errors:** a single exception filter returns `{ error: { code, message, requestId, details? } }`. Unknown errors become a generic 500, and the details are logged with the request id.
- **Logging:** pino through Fastify, with authorization headers, cookies, passwords and tokens redacted. Emails are never logged.
- **Rate limits:** Redis fixed-window counters keyed by IP and by account, shared across instances.
- **Security headers:** the API sends `nosniff`, `no-referrer` and `no-store`. Web sends `X-Frame-Options: DENY` and a restrictive `Permissions-Policy`.
- **Health:** `/health/live` checks the process. `/health/ready` checks the database, Redis and the media bucket, and returns 503 when any is down.
- **Shutdown:** WebSockets close (code 1001) and presence is cleaned up before the database and Redis connections close.
