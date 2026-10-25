# Nexa super app

Nexa is a working codename for a messaging, social, services and payments app for Android, iOS and the web. Its brand, interface and code are all original. Run a trademark search before using the name in public.

**Status: Stage 1 (foundation) and Stage 2 (accounts and sign-in) are in place.** Messaging, calls, social, business, payments and mini-apps are not built yet. [`docs/feature-checklist.md`](docs/feature-checklist.md) shows what is implemented, what is tested, and what is blocked.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS 11 (Fastify) backend: REST API, Postgres migrations, Redis rate limits |
| `apps/web` | Next.js 15 web app. A server-side layer holds the tokens in httpOnly cookies |
| `apps/mobile` | Flutter 3.47 app for Android and iOS. Web builds are possible but `apps/web` is the main web client |
| `packages/design-tokens` | One `tokens.json` that generates CSS variables and a Dart theme |
| `infra/` | docker-compose with local Postgres, Redis and Mailpit |
| `docs/` | Architecture, ADRs, risks, plan, security and privacy notes, API reference |

## Quick start

```bash
corepack enable && pnpm install
docker compose -f infra/docker-compose.yml up -d        # Postgres 16, Redis 7, Mailpit
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
pnpm --filter @nexa/api test        # 45 tests, real Postgres + Redis (database superapp_test)
pnpm --filter @nexa/web test        # cookie/secret-exposure guards
pnpm --filter @nexa/web test:e2e    # Chromium → Next → API → Postgres/Redis/SMTP (needs both apps built)
pnpm --filter @nexa/design-tokens test
cd apps/mobile && flutter analyze && flutter test
```

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

## Docs

- [Architecture](docs/architecture.md) and [ADRs](docs/adr/)
- [Implementation plan](docs/plan.md) and [feature checklist](docs/feature-checklist.md)
- [Risks](docs/risks.md)
- [Security and privacy](docs/security-privacy.md)
- [API reference](docs/api.md)
- [Local development](docs/local-dev.md)
