# Nexa super app

Nexa is a working codename for a messaging, social, services and payments app for Android, iOS and the web. Its brand, interface and code are all original. Run a trademark search before using the name in public.

**Status: Stages 1 to 3 are in place: foundation, accounts, and chats with media. Stage 4 push notifications work in browsers; iPhone and Android need Apple and Firebase credentials ([`docs/push.md`](docs/push.md)). Stage 5 adds group chats, follows, a feed with posts and stories, and communities with moderation. Stage 6 adds one-to-one voice and video calls over WebRTC; real networks need a TURN provider ([`docs/calls.md`](docs/calls.md)).** Chats are **not end-to-end encrypted** yet (blocked on a licence review, see ADR 0004). Business, payments and mini-apps are not built yet. [`docs/feature-checklist.md`](docs/feature-checklist.md) shows what is implemented, what is tested, and what is blocked.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 11 (Fastify) backend: REST API, WebSocket gateway, push delivery worker, Postgres migrations, Redis (rate limits, presence, fan-out), S3-compatible media storage |
| `apps/web` | Next.js 15 web app. A server-side layer holds the tokens in httpOnly cookies |
| `apps/mobile` | Flutter 3.47 app for Android and iOS. Web builds are possible but `apps/web` is the main web client |
| `packages/design-tokens` | One `tokens.json` that generates CSS variables and a Dart theme |
| `infra/` | docker-compose with local Postgres, Redis, SeaweedFS (S3) and Mailpit |
| `docs/` | Architecture, ADRs, risks, plan, security and privacy notes, API reference |

## Quick start

```bash
corepack enable && pnpm install
docker compose -f infra/docker-compose.yml up -d        # Postgres 16, Redis 7, SeaweedFS (S3), Mailpit
cp .env.example apps/api/.env                            # then fill in JWT_ACCESS_SECRET and DATA_ENCRYPTION_KEY
set -a; . apps/api/.env; set +a
pnpm --filter @nexa/api migrate
pnpm --filter @nexa/api dev                              # http://localhost:3000/health/ready
pnpm --filter @nexa/web dev                              # http://localhost:3001
cd apps/mobile && flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
```

Sent emails show up in Mailpit at http://localhost:8025. To work without Docker, see [`docs/local-dev.md`](docs/local-dev.md).

## Tests

```bash
pnpm --filter @nexa/api test        # 249 tests, real Postgres + Redis + S3 (SeaweedFS in CI) (database superapp_test)
pnpm --filter @nexa/web test        # cookie/secret-exposure guards
pnpm --filter @nexa/web test:e2e    # Chromium → Next → API → Postgres/Redis/SMTP/S3, including two people chatting (needs both apps built)
pnpm --filter @nexa/design-tokens test
cd apps/mobile && flutter analyze && flutter test
```

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

## Docs

- [Architecture](docs/architecture.md) and [ADRs](docs/adr/)
- [Implementation plan](docs/plan.md) and [feature checklist](docs/feature-checklist.md)
- [Risks](docs/risks.md)
- [Security and privacy](docs/security-privacy.md)
- [API reference](docs/api.md), [messaging sync and realtime protocol](docs/realtime.md) and [push notifications](docs/push.md)
- [Businesses, orders and bookings](docs/business.md) and the [admin dashboard](docs/admin.md)
- [Local development](docs/local-dev.md)
