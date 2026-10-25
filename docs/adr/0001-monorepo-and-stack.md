# ADR 0001: Monorepo and stack

**Status:** accepted, 2026-10-25

## Context
The project is new. The brief recommends Flutter for mobile, a React framework for web, and NestJS with Postgres and Redis for the backend. A small team has to move across all three without them drifting apart.

## Decision
- One repository with pnpm workspaces for the JavaScript and TypeScript packages. Flutter lives alongside in `apps/mobile`, and shared design tokens are generated for both.
- The backend is **NestJS 11 on Fastify**, with modules for each domain. Fastify gives structured logging (pino), request ids and good throughput.
- Web is **Next.js 15 (App Router)**. Its server layer is a backend-for-frontend, so the browser never holds API tokens.
- **PostgreSQL 16** is the system of record. **Redis 7** holds transient shared state: rate limits now, and presence, typing and fan-out later.
- Validation uses **zod** throughout, which is one library instead of class-validator plus DTO classes.

## Consequences
- One CI pipeline can test every client against the same API.
- The Flutter and web clients each have their own API client. We will generate both from an OpenAPI spec once the API surface grows (tracked in the plan).
- We may need to split the monolith later, and module boundaries are kept strict to make that possible.
