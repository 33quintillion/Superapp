# Implementation plan

Each stage ends with the whole system working, CI green, and the feature checklist updated. Only features with automated tests are marked done.

| Stage | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| **1. Foundation** | Repo, ADRs, risks, design tokens, config, DB and migrations, Redis, errors, logging, health, CI, local infra | `/health/ready` green against real dependencies; migration tests; CI defined | **Done** (CI runs once the PR is open) |
| **2. Identity** | Register, email verification, login, refresh rotation, logout, password reset and change, TOTP MFA, device sessions, profile, privacy settings, blocks, reports, export, deactivate, delete; web and mobile sign-in | All flows covered by API e2e tests, web browser e2e, Flutter widget tests | **Mostly done.** Phone verification and contacts discovery are blocked (see checklist) |
| 3. Messaging | Device keys (libsignal), conversations, 1:1 and groups, WebSocket gateway, per-device queues, receipts, typing, edits and deletes, media upload to object storage with scanning | Offline/reconnect, duplicates, ordering and permissions tests; nothing labelled E2EE until verified | Not started |
| 4. Push, offline and sync | APNs/FCM, notification preferences, background sync, retry queues | Delivery-recovery tests | Not started. **Needs Apple/Google credentials** |
| 5. Social | Groups admin, feed, stories, follows, communities, moderation tools | Privacy and access-control tests (blocked or non-audience users cannot see content) | Not started |
| 6. Calls | WebRTC 1:1 audio and video, signalling, TURN, call history | Connection-failure and permission-denial tests | Not started. **Needs TURN infrastructure** |
| 7. Business and mini-apps | Business accounts, staff RBAC, catalogue, orders, bookings, admin dashboard v1, integration catalogue | RBAC tests; admin MFA enforced | Not started |
| 8. Payments and subscriptions | Provider sandbox checkout, webhooks, ledger, refunds, plans and entitlements | Idempotency and webhook-signature tests | Not started. **Needs provider account and legal review** |
| 9. Hardening | Security review, pen test, load tests, accessibility audit, performance | Report with fixes | Not started |
| 10. Release | Staging, production runbooks, backups and restore drills, monitoring, rollback | Restore drill passed | Not started. **Needs cloud account and domains** |

## Next up (Stage 2 remainder → Stage 3)
1. Generate an OpenAPI spec from the API and use it to produce the web and Flutter clients.
2. Breached-password check (k-anonymity range API, or a bundled list for offline use).
3. Phone verification, once an SMS provider is chosen.
4. Profile photos via presigned uploads to S3-compatible storage.
5. Start Stage 3: libsignal device-key endpoints and the WebSocket gateway.
