# Feature checklist

Legend: ✅ implemented and covered by automated tests · 🟡 partly implemented or untested · ⛔ blocked on something external · ⬜ not started

Test locations: API `apps/api/test/*.spec.ts`; web browser e2e `apps/web/e2e/run.mjs`; Flutter `apps/mobile/test/`.

## Stage 1: Foundation
| Item | Status | Evidence |
| --- | --- | --- |
| Monorepo (pnpm workspaces), pinned versions | ✅ | `package.json`, `docs/architecture.md` |
| Config validation, refusal of unsafe settings | ✅ | `unit.spec.ts › config` |
| Postgres migrations (transactional, locked, checksummed) | ✅ | `migrations.spec.ts` |
| Redis connection and readiness check | ✅ | `auth.e2e.spec.ts › health` |
| Central error format with request ids | ✅ | `auth.e2e.spec.ts › health` |
| Log redaction of secrets | 🟡 | Configured in `app.ts`, no automated assertion yet |
| Design tokens → CSS and Dart, CI staleness check | ✅ | `packages/design-tokens` |
| docker-compose for local dependencies | 🟡 | Written; not run here (no Docker daemon in this environment) |
| CI pipeline | 🟡 | `.github/workflows/ci.yml` written; first run happens on the PR |

## Stage 2: Accounts and identity
| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Email registration, unique username, normalised case | ✅ | `auth.e2e › registration` |
| Email verification (single-use, expiring link) | ✅ | API e2e + web e2e (real SMTP) |
| Login with generic errors and timing equalisation | ✅ | `auth.e2e › login` |
| Refresh rotation and stolen-token detection | ✅ | `auth.e2e › rotates refresh tokens…` |
| Logout, device list, revoke a device | ✅ | `auth.e2e › login and sessions`, web e2e |
| Password recovery (signs out all devices) | ✅ | API e2e + web e2e |
| Password change (keeps current device) | ✅ | `auth.e2e › change-password…` |
| Optional TOTP two-step, replay protection | ✅ | `auth.e2e › two-step verification`; RFC vectors in `unit.spec.ts` |
| Rate limits (register, login per IP and account, reset, MFA, reports) | ✅ | `auth.e2e › rate limiting`, `registration rate limit` |
| Profile: display name, bio, status, locale | ✅ | `users.e2e › profile` |
| Profile photo upload | ⬜ | Needs object storage (Stage 3) |
| Privacy settings (discoverability, who can message, receipts, online) | ✅ (storage and lookup) | `users.e2e`; messaging will enforce "who can message" in Stage 3 |
| Blocking (hides profiles in both directions) | ✅ | `users.e2e › blocking` |
| Reporting | ✅ (user side) | `users.e2e`; moderation queue is part of the admin dashboard (Stage 7) |
| Data export | ✅ | `users.e2e › exports…` |
| Deactivation (reversible by signing in) | ✅ | `users.e2e › deactivation…` |
| Deletion (immediate PII scrub, tombstone) | ✅ | `users.e2e › deletion…` |
| Scheduled purge of tombstones and backups | ⬜ | Needs backup infrastructure |
| Phone number sign-up and verification | ⛔ | Needs an SMS provider account and fraud controls |
| Contacts discovery (opt-in) | ⬜ | Designed for Stage 3; uploading the address book will never be required |
| Breached-password check | ⬜ | Planned |
| Admin MFA enforcement | ⬜ | Admin app is Stage 7 |
| Localisation framework | 🟡 | `locale` stored per user; UI strings not yet extracted |
| Web: sign-in, register, two-step, verify, forgot and reset, devices, sign-out | ✅ | `apps/web/e2e/run.mjs` |
| Mobile: sign-in, register, two-step, profile, sign-out, secure token storage | ✅ (widget tests with HTTP stubbed) | `apps/mobile/test/auth_flow_test.dart` |
| Mobile on a real device or emulator | 🟡 | Not run (no emulator here); `flutter analyze` is clean |

## Stages 3 to 10
Not started. See `plan.md`. Nothing for messaging, calls, social, business, payments, subscriptions, mini-apps or the admin dashboard is implemented. The app does not pretend otherwise: the home screen says these are coming in later stages.
