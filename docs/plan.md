# Implementation plan

Each stage ends with the whole system working, CI green, and the feature checklist updated. Only features with automated tests are marked done.

| Stage | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| **1. Foundation** | Repo, ADRs, risks, design tokens, config, DB and migrations, Redis, errors, logging, health, CI, local infra | `/health/ready` green against real dependencies; migration tests; CI defined | **Done** (CI runs once the PR is open) |
| **2. Identity** | Register, email verification, login, refresh rotation, logout, password reset and change, TOTP MFA, device sessions, profile, privacy settings, blocks, reports, export, deactivate, delete; web and mobile sign-in | All flows covered by API e2e tests, web browser e2e, Flutter widget tests | **Mostly done.** Phone verification and contacts discovery are blocked (see checklist) |
| 3. Messaging | Conversations (1:1), WebSocket gateway, change feed, receipts, typing, presence, edits and deletes, reactions, pins, forwarding, search, media upload to object storage | Offline/reconnect, duplicates, ordering and permissions tests; nothing labelled E2EE until verified | **Mostly done.** E2EE is blocked on the libsignal licence review; media scanning needs a provider; groups moved to Stage 5 (see checklist) |
| **4. Push, offline and sync** | APNs/FCM, notification preferences, background sync, retry queues | Delivery-recovery tests | **Partly done.** Push server, retry queue, preferences and browser notifications built and tested. iPhone and Android need APNs/FCM credentials and app registration; durable outboxes and background sync not started (see checklist) |
| 5. Social | Groups admin, feed, stories, follows, communities, moderation tools | Privacy and access-control tests (blocked or non-audience users cannot see content) | Not started |
| 6. Calls | WebRTC 1:1 audio and video, signalling, TURN, call history | Connection-failure and permission-denial tests | Not started. **Needs TURN infrastructure** |
| 7. Business and mini-apps | Business accounts, staff RBAC, catalogue, orders, bookings, admin dashboard v1, integration catalogue | RBAC tests; admin MFA enforced | Not started |
| 8. Payments and subscriptions | Provider sandbox checkout, webhooks, ledger, refunds, plans and entitlements | Idempotency and webhook-signature tests | Not started. **Needs provider account and legal review** |
| 9. Hardening | Security review, pen test, load tests, accessibility audit, performance | Report with fixes | Not started |
| 10. Release | Staging, production runbooks, backups and restore drills, monitoring, rollback | Restore drill passed | Not started. **Needs cloud account and domains** |

## Next up (Stage 4 remainder)
1. **Apple and Firebase accounts:** create the APNs key and the Firebase project ([`push.md`](push.md)), then register for push in the Flutter app (permission prompt, token, tap handling, delivered receipts).
2. Durable outboxes (IndexedDB on the web, local storage on mobile), and background sync on mobile.
3. Clear notifications on other devices when a chat is read on one.
4. Legal review of libsignal's licence, then device keys and per-device ciphertext envelopes (ADR 0004).
5. Choose a malware and CSAM scanning provider before media sharing goes public.
6. Flutter: pick and send photos and files, and record voice notes. Profile photos using the media pipeline.
7. Still open from Stage 2: OpenAPI spec and generated clients, breached-password check, phone verification once an SMS provider is chosen.
