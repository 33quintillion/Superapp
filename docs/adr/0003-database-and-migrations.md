# ADR 0003: Database access and migrations

**Status:** accepted, 2026-10-25

## Decision
- The app uses plain parameterised SQL through `pg`, with a thin `DatabaseService` (`query`, `one`, `tx`). There is no ORM. Queries stay visible and reviewable, and ORM-driven N+1 and migration drift are avoided.
- Migrations are forward-only SQL files in `apps/api/migrations/NNNN_name.sql`, applied by `src/database/migrator.ts`:
  - each file runs in its own transaction, so a failure rolls back cleanly (tested);
  - a Postgres advisory lock serialises concurrent deploys;
  - every applied file is checksummed, and editing an applied migration stops the run (tested).
- Tests rebuild the schema from the migrations on each run, which proves the migrations alone produce a working database.

## Consequences
- Rollback means writing a new forward migration. Destructive changes follow expand-then-contract over two releases.
- Typed query results are hand-written interfaces. Revisit (for example with Kysely) if this becomes error-prone.
