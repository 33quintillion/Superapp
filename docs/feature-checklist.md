# Feature checklist

Legend: ✅ implemented and covered by automated tests · 🟡 partly implemented or untested · ⛔ blocked on something external · ⬜ not started

Test locations: API `apps/api/test/*.spec.ts`; web browser e2e `apps/web/e2e/run.mjs`; Flutter `apps/mobile/test/`.

Last full run (2026-10-28, Stage 1–9 leftovers): API 331 tests passed; web e2e all 60 steps passed, including calls through a real coturn relay, the business and admin flow, card payments against the local Stripe stand-in, and the accessibility audit; Flutter 49 tests passed and `flutter analyze` clean.

## Stage 1: Foundation
| Item | Status | Evidence |
| --- | --- | --- |
| Monorepo (pnpm workspaces), pinned versions | ✅ | `package.json`, `docs/architecture.md` |
| Config validation, refusal of unsafe settings | ✅ | `unit.spec.ts › config` |
| Postgres migrations (transactional, locked, checksummed) | ✅ | `migrations.spec.ts` |
| Redis connection and readiness check | ✅ | `auth.e2e.spec.ts › health` |
| Central error format with request ids | ✅ | `auth.e2e.spec.ts › health` |
| Log redaction of secrets | ✅ | `logging.e2e` runs the real logger at trace level through sign-up, login, refresh and an authorised request, and checks no password, token or cookie appears; also when code logs a whole request or body |
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
| Profile photo upload | ✅ | `media.e2e › profile photos`, web e2e `profile photo uploaded from the account page…`, Flutter `sets, shows and removes the profile photo…`. Counts as public media: same scanning blocker before public launch |
| Privacy settings (discoverability, who can message, receipts, online) | ✅ | `users.e2e`; enforced in messaging by `messaging.e2e › permissions`, `› receipts` and `realtime.e2e › presence` |
| Blocking (hides profiles in both directions) | ✅ | `users.e2e › blocking` |
| Reporting | ✅ | `users.e2e` (user side); moderation queue in `admin.e2e › the report queue` (Stage 7) |
| Data export | ✅ | `users.e2e › exports…` |
| Deactivation (reversible by signing in) | ✅ | `users.e2e › deactivation…` |
| Deletion (immediate PII scrub, tombstone) | ✅ | `users.e2e › deletion…` |
| Scheduled purge of tombstones and backups | ⬜ | Needs backup infrastructure |
| Phone number sign-up and verification | ⛔ | Needs an SMS provider account and fraud controls |
| Contacts discovery (opt-in) | ✅ (phone address-book reading untested on a real device) | `users.e2e › finding people you know…`, web e2e `find people by email address, only those who opted in`, Flutter `find people you know…`. Being findable is off by default; the address book is read only when the person taps the button, and nothing sent is stored. Phone numbers only match once phone sign-up exists |
| Breached-password check: new passwords (sign-up, reset, change) refused if in Have I Been Pwned's Pwned Passwords, by k-anonymity (only a 5-character hash prefix leaves the server), plus a built-in list of the most common ones; allowed if the service is down | ✅ | `breached-passwords.e2e` (against a local stand-in for the service) |
| Admin MFA enforcement | ✅ | `admin.e2e › requires two-step verification to be on`, `› requires the session itself to have been opened with a two-step code, recently` (Stage 7) |
| Localisation framework | 🟡 | `locale` stored per user; UI strings not yet extracted |
| Web: sign-in, register, two-step, verify, forgot and reset, devices, sign-out | ✅ | `apps/web/e2e/run.mjs` |
| Mobile: sign-in, register, two-step, profile, sign-out, secure token storage | ✅ (widget tests with HTTP stubbed) | `apps/mobile/test/auth_flow_test.dart` |
| Mobile: refresh an expired access token once and retry | ✅ | `chat_test.dart › an expired access token…` |
| Mobile on a real device or emulator | 🟡 | Not run (no emulator here); `flutter analyze` is clean |

## Stage 3: Messaging and media
Chats are **not end-to-end encrypted** (see the E2EE row). API tests use real Postgres, Redis and S3-compatible storage (SeaweedFS in CI).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| One-to-one conversations (one per pair, symmetric) | ✅ | `messaging.e2e › direct conversations` |
| Group chats with admins and member permissions | ✅ | Built in Stage 5, see below |
| Text messages, replies, mentions | ✅ | `messaging.e2e › validates content, replies and mentions` |
| Reactions (one per person, change or remove) | ✅ | `messaging.e2e › keeps one reaction per person…`; web e2e; Flutter `chat_test` |
| Edit (sender, 15 min) and delete for everyone (sender, 48 h) or for me | ✅ | `messaging.e2e › editing, deleting…` |
| Pinning (10 per chat) and forwarding | ✅ | `messaging.e2e › pins…`, `› forwards…` |
| Search (word prefix, own chats only, skips deleted and hidden) | ✅ | `messaging.e2e › finds words by prefix…`; web e2e |
| History pagination (before/after) and change feed for sync | ✅ | `messaging.e2e › history and sync` |
| Ordering under concurrency (gap-free per-chat counter) | ✅ | `messaging.e2e › gives concurrent sends unique, gap-free sequence numbers` |
| Retry deduplication by clientId (including concurrent retries) | ✅ | `messaging.e2e › treats a retry…`, `realtime.e2e › a resend after a lost ack…`, Flutter `chat_test` |
| Offline catch-up on reconnect | ✅ | `realtime.e2e › a device that was offline catches up…`; web e2e (browser offline and back); Flutter `chat_test` |
| Delivery and read receipts, with reciprocal privacy | ✅ | `messaging.e2e › receipts`, `realtime.e2e › withholds read positions…`; web e2e |
| Typing indicators (not across blocks) | ✅ | `realtime.e2e › relays typing…`; web e2e; Flutter `chat_test` |
| Online presence and last seen (peers only, reciprocal setting) | ✅ | `realtime.e2e › presence` |
| Authenticated WebSocket (single-use tickets, origin check, session re-check) | ✅ | `realtime.e2e › connecting` |
| Fan-out across API instances (Redis) | ✅ | `realtime.e2e › fans out across API instances…` |
| Permissions: outsiders get 404 everywhere; blocks and "who can message" enforced | ✅ | `messaging.e2e › keeps outsiders out…`, `› permissions` |
| Mute and archive (per person) | ✅ | `messaging.e2e › lists conversations…` |
| Image, video, audio and file sharing via presigned uploads to object storage | ✅ (API, web), ✅ photos in Flutter | `media.e2e`; web e2e uploads a photo; Flutter `chat_test › sends a photo with a caption and records a voice note…` (photo library picker, re-encoded on the phone so location metadata isn't sent). Flutter can't send video or other files yet, and opens voice notes and files in the phone's own player |
| Voice notes | ✅ API, 🟡 web, 🟡 Flutter | `media.e2e › sends a voice note…`. Web records with MediaRecorder and Flutter with the `record` package (AAC in M4A); both tests use a fake microphone, and neither has run on a real microphone here. Flutter `chat_test › …records a voice note…` covers record, cancel, send and a refused microphone |
| Upload checks: type allow-list, size limits, file signature, uploader-only completion | ✅ | `media.e2e`, `unit.spec › media signatures` |
| Media access only for uploader and chat members; file removed when no message uses it | ✅ | `media.e2e › uploads straight to storage…`, `› deletes the stored file…` |
| Malware scanning and known-CSAM hash matching | ⛔ | Needs a scanning service and a child-safety partner. **Media must not be opened to the public before this** |
| Thumbnails and video transcoding | ⬜ | Planned with the media pipeline |
| Account deletion wipes sent messages and files; export includes sent messages | ✅ | `messaging.e2e › account deletion and export` |
| Web chat screen (list, thread, ticks, typing, presence, reactions, edit, delete, pin, forward, search, attachments, voice) | ✅ except voice in the browser | `apps/web/e2e/run.mjs › chatFlow` covers chat open, typing, presence, live delivery, read ticks, reply, offline catch-up, reaction, edit, pin, forward into a group, photo, search and proxy limits. Voice recording is in the UI but the browser test has no microphone |
| Web chat proxy limited to messaging; refuses cross-site writes | ✅ | web e2e |
| Mobile chat screens (list, thread, ticks, typing, reactions, edit, delete, pin) | ✅ (widget tests with HTTP and socket faked) | `apps/mobile/test/chat_test.dart` |
| Message notifications | ✅ browsers, ⛔ iPhone and Android | See Stage 4 below |
| End-to-end encryption (libsignal) | ⛔ | Blocked on legal review of libsignal's AGPL-3.0 licence (ADR 0004). Nothing is labelled E2EE |
| Durable outbox (survives app restart) | ✅ | Flutter keeps unsent messages in the keystore, the web in the browser's local storage; both re-send them with their original ids when the chat opens again and wipe them on sign-out (`chat_test › a message left unsent when the app closed…`, `› unsent messages are wiped…`; web e2e "a message typed offline survives closing the tab…"). An upload still in progress isn't kept |
| Load test of fan-out and presence | ✅ | `apps/api/load/run.mjs`, results in `docs/hardening.md` (one instance; multi-instance needs staging) |

## Stage 4: Push, offline and sync
Push services are exercised against local servers that speak the real protocols and check our signatures (`apps/api/test/push-fakes.ts`): HTTP/2 for APNs, OAuth plus HTTP v1 for FCM, and encrypted Web Push that the test decrypts like a browser. No Apple or Google account was used. See [`push.md`](push.md).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Device registration per session (APNs, FCM, Web Push), token moves between accounts, removal, no tokens in responses | ✅ | `push.e2e › registration` |
| Web Push endpoints limited to real browser push services (no server-side request forgery) | ✅ | `push.e2e › only accepts Web Push endpoints on known push services` |
| Notification settings: on/off, preview level (full, sender, none), quiet hours in the person's time zone | ✅ | `push.e2e › respects the preview setting`, `› sends quietly during quiet hours`, `› validates notification settings`; `push.unit › quiet hours`; web e2e |
| Per-chat mute and "push off" stop notifications | ✅ | `push.e2e › sends nothing for muted chats…` |
| Transactional outbox: notification queued in the same transaction as the message | ✅ | `push.e2e › delivers a new message…` |
| Re-check at send time: read elsewhere, deleted, muted, blocked, signed out | ✅ | `push.e2e › drops a notification that is no longer useful…`, `› drops queued notifications after a block or sign-out` |
| Retries with exponential backoff and Retry-After; give up after 8 attempts | ✅ | `push.e2e › retries with backoff…`, `› gives up after the maximum attempts`; `push.unit › backs off…` |
| Dead tokens disabled; re-registering re-enables | ✅ | `push.e2e › disables an expired subscription…` |
| Crash recovery (lease expiry) and no double sends across API instances | ✅ | `push.e2e › recovers a job claimed by a worker that crashed…`, `› never sends a job twice when several API instances run workers` |
| Worker wakes immediately on a new message | ✅ | `push.e2e › runs on its own and wakes as soon as a message is sent` |
| Web Push encryption (RFC 8291) and VAPID (RFC 8292) | ✅ | `push.unit › matches the RFC test vector`, `› VAPID` |
| APNs provider (HTTP/2, ES256 provider token, error mapping, token refresh) | ✅ against a local stand-in, ⛔ against Apple | `push.unit › APNs provider`, `push.e2e › reaches every signed-in device…`. **Needs an Apple Developer account and a .p8 key** |
| FCM provider (HTTP v1, service-account OAuth, error mapping) | ✅ against a local stand-in, ⛔ against Google | `push.unit › FCM provider`, `push.e2e › reaches every signed-in device…`. **Needs a Firebase project and service account** |
| Test notification to the current device | ✅ | `push.e2e › sends a test notification…` |
| Export lists devices and settings (no tokens); deactivation and deletion remove them | ✅ | `push.e2e › account lifecycle` |
| Web: notification settings, turn browser notifications on and off, service worker shows the notification, reports "delivered", opens the chat on click | ✅ settings and service worker, 🟡 subscribing and click | Web e2e `notificationsFlow` saves settings and hands the service worker a push (via Chrome DevTools Protocol), checking the notification and the delivered receipt. Subscribing needs a real browser push service, so the "Turn on" button and opening the chat from a click are not browser-tested; the API side of subscribing is |
| iPhone and Android: permission prompt, token registration, tap handling | ⛔ | Needs the APNs key and Firebase project above, then Flutter work |
| Clear notifications on other devices after reading | ✅ server and web, ⬜ phone apps | `push.e2e › clearing notifications…`, web e2e `reading on another device clears the notification here`; phone handling waits for APNs/FCM setup |
| Durable outbox (survives app restart) on mobile | ✅ | See Stage 2 above |
| Background sync on mobile (fetching while the app is closed) | ⛔ | Needs push (APNs/FCM) to wake the app |
| Queue metrics and alerting | ⬜ | Stage 10 monitoring |

## Stage 5: Social
Who can see a post, story, comment, community or file is decided in Postgres by shared SQL functions (`can_view_post`, `can_view_story`, `can_view_community` and friends in `migrations/0004_social.sql`), so every list, single read and media download applies the same rules. People who blocked each other never see each other's posts, stories, comments or likes.

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Group chats: create (up to 256), title and description, owner/admin/member roles | ✅ | `groups.e2e › creates a group…`, `› validates the title…`; web e2e; Flutter `social_test › groups` |
| "Who can add me to groups" privacy setting (everyone, people I follow, nobody) and blocks respected when adding | ✅ | `groups.e2e › respects who can add me to groups, and blocks`; Flutter shows the refusal |
| New members only see messages from when they joined | ✅ | `groups.e2e › shows people added later only what was sent after they joined` |
| Admins-only messaging, admins-only info editing, who can add people | ✅ | `groups.e2e › enforces admins-only…`, `› lets only admins add…`; web e2e (composer closes live); Flutter `social_test` |
| Role hierarchy for promote, demote and remove; ownership passes on when the owner leaves or deletes their account | ✅ | `groups.e2e › applies the role hierarchy…`, `› passes ownership on…`, `› removes a deleted account…` |
| Group notices ("Ada added Ben") and live updates to members; removed people are told | ✅ | `groups.e2e › announces changes…`; web e2e; Flutter `social_test` |
| Follow and unfollow; private accounts approve follow requests | ✅ | `social.e2e › follows`; web e2e approves a request from the account page |
| Posts with audiences (everyone, followers, only me), photos, likes, comments, shares that never widen the original audience | ✅ | `social.e2e › posts and the feed`; web e2e (followers-only photo post, like, comment, non-follower can't see it); Flutter `social_test › feed`, `› photos` |
| Retry-safe posting (clientId) | ✅ | `social.e2e › is idempotent on clientId…` |
| Home feed (own posts, people you follow, communities you joined), newest first with stable paging | ✅ | `social.e2e › builds the feed…` |
| Stories: text and photo, 24-hour expiry with a sweep that deletes files, followers-only option, view tracking visible only to the author | ✅ | `social.e2e › stories`; web e2e; Flutter `social_test › feed` (text stories, marked seen), `› photos` (photo stories) |
| Communities and channels: public or private, join and request to join, approve, ban, roles, admins-only posting in channels, owner hand-over and deletion | ✅ | `social.e2e › communities and channels`; web e2e; Flutter `social_test › communities` |
| Community moderation: remove posts and comments with a reason (audited), ban, rank checks | ✅ | `social.e2e › moderates…`; web e2e (moderator removes a post) |
| Reports on posts, comments, stories and communities | ✅ (user side) | `social.e2e › accepts reports…`; Flutter reports a post. The review queue is the Stage 7 admin dashboard |
| Spam protection: per-person rate limits on posts (30/h), comments (120/h), likes (600/h), stories (50/day), follows (200/day), community creation (5/day) and joins (100/day), group creation (20/h) | ✅ limits, ⬜ spam classifier | `social-limits.e2e` checks each limit's size, that it is per person, and the `Retry-After` header. No spam classifier |
| Export and account deletion include all social data; deactivated accounts' posts are hidden | ✅ | `social.e2e › exports social data…`, `› hides a deactivated account’s posts` |
| Web: groups, feed, profiles with follow, stories, communities, privacy settings | ✅ for the flows in the browser test | `apps/web/e2e/run.mjs › socialFlow` |
| Flutter: groups, feed, stories, comments, posting, communities | ✅ (widget tests with HTTP and socket faked) | `apps/mobile/test/social_test.dart` |
| Flutter: photos on posts (up to 10, removable before posting, not re-uploaded on retry) and photo stories, shown in the feed and story viewer | ✅ | `social_test › photos: a post with several photos…`. Not run on a real phone's photo library here |
| Notifications for follows, likes, comments and requests; live feed updates | ⬜ | Feed refreshes on pull; chat push is unaffected |
| Moderation dashboard for reports | ✅ | Built in Stage 7: `admin.e2e › the report queue`; web e2e `businessFlow` |
| Malware and CSAM scanning of post and story photos | ⛔ | Same blocker as chat media. **Do not open public posting to the internet before this** |
| Feed performance at scale | ✅ / ⬜ | Measured in Stage 9 and rewritten to read each source by index: 44 to 79 ms median with 100,000 posts (`docs/hardening.md`, `hardening.e2e.spec.ts`). Fan-out on write not built |

## Stage 6: Calls
One-to-one voice and video over WebRTC. The API signals and keeps history; media goes between the devices or through TURN. Details and provider setup: [`calls.md`](calls.md).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Signalling over the WebSocket: start, ring every device, answer on one, offer/answer/ICE relayed only to the device in the call | ✅ | `calls.e2e › rings every device of the callee, and only the answering device takes part`; web e2e `callsFlow`; Flutter `calls_test` |
| Same rules as direct messages: blocks and "who can message me"; people outside the chat and group chats refused | ✅ | `calls.e2e › who can call whom` |
| One live call per person; busy; two devices answering at once; two people calling each other at once | ✅ | `calls.e2e › calling someone already on a call…`, `› only one of two devices answering…`, `› two people calling each other…` |
| Accept, decline, cancel, end; mute, camera on/off; speaker and flip camera (phones) | ✅ web, ✅ Flutter with fake media | Web e2e (real browsers, fake devices); Flutter `calls_test › outgoing video call…` |
| Incoming and outgoing call screens | ✅ | Web e2e; Flutter `calls_test` |
| Call history (both sides, paging, call back) and call notices in the chat | ✅ | `calls.e2e › records a completed call…`, `› pages call history…`; web e2e; Flutter `calls_test › call history…` |
| Missed calls: ring timeout, notice in the chat, push notification | ✅ | `calls.e2e › a call nobody answers rings out as missed…` (decrypts the real Web Push payload); web e2e "No answer" / "Missed voice call" |
| Connection failures: answered but never connected, device reports failure, TURN relay down | ✅ | `calls.e2e › failures and recovery`; web e2e "relay unreachable: the call fails cleanly on both sides"; Flutter `calls_test › media that breaks…` |
| Recovery: signalling socket drops mid-call and resumes; ICE restart; grace period then `connection_lost` | ✅ | `calls.e2e › a dropped connection can come back…`, `› …ends the call as connection lost`; web e2e (browser goes offline mid-call, call continues); Flutter `calls_test › a dropped socket resumes…` |
| Network quality: RTT and loss from WebRTC stats, "Poor connection" hint, video bitrate caps | ✅ Flutter (fake stats), 🟡 web | Flutter `calls_test › poor network…`. On the web the same logic runs, but the e2e network is never poor, so the hint itself is not browser-tested |
| Permission denial (microphone or camera blocked) handled for outgoing and incoming calls | ✅ | Web e2e (permissions cleared in Chromium); Flutter `calls_test › blocked microphone…` |
| TURN credentials: coturn (shared secret), Twilio, Cloudflare; STUN-only fallback; relay-only option; startup checks | ✅ coturn for real, ✅ Twilio and Cloudflare against local stand-ins, ⛔ against the real services | `calls.e2e › ICE servers`, `› managed TURN providers`; web e2e relays through a real coturn. **Twilio or Cloudflare need an account to try for real** |
| Export includes call history | ✅ | `calls.e2e › includes call history in the data export` |
| Flutter media engine (flutter_webrtc) on real Android and iOS devices | 🟡 | Written and type-checked; camera and microphone permissions declared. Not run on a device in this environment |
| Ring when the phone app is closed (PushKit/CallKit on iOS, high-priority FCM on Android) | ⛔ | Needs the Apple and Firebase accounts from Stage 4. Until then, a closed app gets a missed-call notification |
| Group calls | ⬜ | Needs a media server (SFU), e.g. LiveKit or mediasoup |
| Verified end-to-end encryption of calls (key comparison, SFrame) | ⬜ | Calls use DTLS-SRTP between devices; keys are not verified (see `security-privacy.md`) |
| Call quality reporting to the server for monitoring | ⬜ | Stage 10 |

## Stage 7: Business, admin dashboard and integrations
Business accounts with staff roles, a catalogue with pickup orders, bookings, the admin dashboard with the moderation queue, and the integration catalogue. No money moves yet: orders are pay in person until Stage 8. Details: [`business.md`](business.md), [`admin.md`](admin.md).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Business accounts: create, profile, opening hours, time zone and currency checks, search, close | ✅ | `business.e2e › business accounts`; web e2e `businessFlow`; Flutter `business_test` |
| Staff roles (owner, manager, staff): invitations that must be accepted, role matrix, managing only lower roles, ownership hand-over | ✅ | `business.e2e › staff roles` (every kind of change checked against the matrix); `unit › gives each role exactly the permissions in the matrix`, `› lets people manage only roles below their own` |
| Catalogue: items with prices, availability, optional stock, archiving | ✅ | `business.e2e › shows customers only what they can buy…`, `› refuses orders while ordering is off, and archives items…` |
| Pickup orders: server-side pricing, stock taken atomically, safe retries, statuses, restock on cancel or reject, live updates to both sides | ✅ | `business.e2e › prices orders from the catalogue…`, `› never sells the last item twice when orders race`, `› moves orders through their statuses…`; web e2e; Flutter `business_test` |
| Bookings: slots from opening hours in the business's time zone, capacity, no overbooking under races, cancel, outcome | ✅ | `business.e2e › bookings`; web e2e; Flutter `business_test › books a free time…` |
| Suspended and closed businesses; account deletion hands a business to a manager or closes it; export includes orders, bookings and roles | ✅ | `business.e2e › suspension, closing and account deletion` |
| Admin dashboard access: platform staff only, two-step on, session opened with a two-step code within 12 hours, admin-only areas | ✅ | `admin.e2e › who can use the admin dashboard`; web e2e (non-staff refused) |
| Moderation queue: child safety first, claim, subject preview (only the reported message), remove content, dismiss, suspend or restore authors, staff protected | ✅ | `admin.e2e › the report queue` |
| Admin: verify, suspend and restore businesses; add and remove moderators; audit log of every admin action; overview counts; CLI to grant the first admin | ✅ | `admin.e2e › businesses, staff and the audit log` |
| Integration catalogue: admin publishes, people connect with only the scopes they tick and can revoke, kill switch, re-review when scopes widen, grants trimmed when they narrow | ✅ | `admin.e2e › integration catalogue and the kill switch`; web e2e |
| Flutter: browse businesses, order for pickup, book, my orders and bookings | ✅ | `business_test` |
| Flutter back office for staff: orders queue, bookings with came/no-show/cancel, item catalogue, tabs by role | ✅ | `back_office_test` |
| Item photos and viewing reported media in the queue | ⛔ | Needs the media scanning provider (same blocker as chat media) |
| Online payment for orders and booking deposits | ✅ | Stage 8 below |
| Business verification checks (documents, company registry) | ⛔ | Needs a verification provider; admins mark businesses verified by hand today |
| Partner API for integrations (OAuth, tokens, webhooks) | ⛔ | Needs a partner agreement and terms; the catalogue and grants are in place |
| Escalation of child-safety reports to NCMEC or IWF | ⛔ | Needs legal and trust-and-safety sign-up |
| Push notifications to staff for new orders and bookings | ⛔ | Needs the APNs and Firebase accounts from Stage 4; staff get live updates while the page is open |

## Stage 8: Payments and subscriptions
Card payments for pickup orders, payouts to businesses, refunds, a double-entry ledger and business plans, through Stripe. **Tested against a local stand-in for Stripe** (`apps/api/src/dev/stripe-sandbox.ts`), which signs webhooks and checks idempotency keys the way Stripe does; nothing has run against a real Stripe account yet. Details: [`payments.md`](payments.md).

| Item | Status | Evidence / blocker |
| --- | --- | --- |
| Payout accounts: owner-only Connect onboarding on the provider's hosted page; status from webhooks, or read from the provider when one was missed; pay-at-pickup can only be turned off once card payment works | ✅ | `payments.e2e › payout accounts`; web e2e `paymentsFlow` |
| Paying for an order: held as `pending_payment` with its stock, hosted checkout (no card data on our servers), handed to staff once the signed webhook says paid, ledger entries for the sale and fee | ✅ | `payments.e2e › holds the order until it is paid…`; web e2e `paymentsFlow`; Flutter `business_test › pays online…`, `› shows how each order was paid…` |
| **Idempotency:** one checkout when the provider times out and the customer retries; safe retries of placing an order and of refunds; provider keys made from our row ids | ✅ | `payments.e2e › creates one checkout even when the provider times out…`, `› is safe to retry placing the order…`, `› lets managers refund … once per request…`, `› retries a refund with the same key when the provider was down` |
| **Webhook signatures:** HMAC-SHA256 with a tolerance window, several secrets while rotating, unsigned or tampered events refused and change nothing, other-mode events refused | ✅ | `payments.e2e › webhooks › rejects events that aren’t signed…`, `› accepts the previous secret while it is being rotated out`, `› refuses events from the other mode…`; `unit › Stripe webhook signatures` |
| Webhook deduplication: a redelivered event is applied once, even when copies arrive together | ✅ | `payments.e2e › applies a redelivered event once, even when copies arrive together` |
| Checkouts that expire or that the customer abandons: order cancelled, stock returned; a payment that lands after the order closed is refunded | ✅ | `payments.e2e › cancels the order and gives the stock back…`, `› closes the checkout when the customer cancels…`, `› refunds a payment that arrives after the order was closed` |
| Sweep for lost webhooks: asks the provider how each checkout ended, resends refunds | ✅ | `payments.e2e › tidies up when webhooks are lost…` |
| Refunds: managers and owners, partial or full, never more than paid, proportional fee returned, automatic full refund when a paid order is rejected or cancelled, failed refunds give the amount back, dashboard refunds recorded | ✅ | `payments.e2e › refunds`; web e2e `paymentsFlow` |
| Closing a business or deleting an account refunds open paid orders, ends the plan, and keeps the payment record without the person | ✅ | `payments.e2e › closing and leaving` |
| Ledger: double-entry, the database refuses unbalanced transactions and changes to past entries, admin check agrees with every payment and refund | ✅ | `payments.e2e › the ledger`; web e2e (admin ledger check shows balanced) |
| Business plans: admin-only plan creation at the provider, hosted subscription checkout, entitlements raise staff and catalogue limits only while paid for, late events ignored, cancelled stays cancelled, a second subscription is ended | ✅ | `payments.e2e › business plans`; web e2e `paymentsFlow` |
| Payments configuration: provider off by default, key and secret formats, live keys only in production, the stand-in's address refused when deployed | ✅ | `unit › payments configuration`, `unit › Stripe form encoding` |
| Web: pay by card, payment result page, refunds for staff, payouts setup, plans and limits, admin ledger, plans and payments | ✅ | web e2e `paymentsFlow` |
| Flutter: pay by card through the browser, "Pay now" for a held order, payment status in my orders | ✅ | `business_test` |
| Running against a real Stripe test account, then live | ⛔ | Needs a Stripe account and Connect platform approval |
| Launch countries, seller and buyer terms, refund policy, consumer-law review | ⛔ | Needs legal review |
| Plans or digital goods sold to individuals in the mobile apps | ⛔ | Needs App Store and Google Play billing; plans are sold to businesses only for now |
| Razorpay or another regional provider | ⛔ | Needs a provider decision and an account |
| Booking deposits: optional per service, held as `pending_payment` until paid through hosted checkout, refunded when cancelled in time or by the business, kept after a late cancel or a no-show, managers can refund | ✅ | `payments-more.e2e › booking deposits`; web e2e `paymentsFlow` |
| Disputes and chargebacks: the business's share is taken back while the bank decides and returned if the business wins, refunds refused meanwhile, the business sends its side from the payments tab, admin list | ✅ | `payments-more.e2e › disputes`; web e2e `paymentsFlow` |
| Changing plan in place: preview of today's cost, upgrade charges the difference, downgrade gives credit, monthly to yearly, declined card keeps the old plan | ✅ | `payments-more.e2e › changing plan`; web e2e `paymentsFlow` |
| Payouts list for the business, and reconciliation of the ledger against the provider's balance records (admin) | ✅ | `payments-more.e2e › payouts and reconciliation`; web e2e `paymentsFlow` |
| No-show fees charged beyond the deposit | ⬜ | Needs saved cards (off-session charges); the deposit is kept instead |
| Flutter back office for payouts, refunds, disputes and plans; booking deposits for customers | ✅ | `back_office_test` |

## Stage 9: Hardening
Details and numbers in `hardening.md`.

| Item | Status | Evidence |
| --- | --- | --- |
| Dependencies free of known vulnerabilities | ✅ | `pnpm audit` clean; Fastify and PostCSS pinned in `pnpm-workspace.yaml` |
| Client addresses can't be forged (API and web) | ✅ | `hardening.e2e.spec.ts`, `unit.spec.ts`, `apps/web/test/client-address.test.mjs` |
| Limits on password re-entry, two-step codes per account, export, sockets per person | ✅ | `hardening.e2e.spec.ts`, `realtime.e2e.spec.ts` |
| Content Security Policy with nonces, HSTS | ✅ | Web e2e "Content Security Policy"; the other e2e flows run under it |
| Load tests: fan-out, throughput, presence, feed | ✅ | `apps/api/load/run.mjs` (run by hand; not in CI) |
| Feed query rewrite | ✅ | `hardening.e2e.spec.ts` "feed", `social.e2e.spec.ts` |
| Web accessibility: axe-core WCAG 2.2 AA on 17 screens, light and dark; skip link; focus rings | ✅ | Web e2e `a11yFlow` (`E2E_ONLY=a11y`) |
| Independent penetration test | ⬜ | Needs staging (Stage 10) |
| Multi-instance and soak load tests | ⬜ | Needs staging |
| Flutter accessibility: automated checks (48×48 and 44×44 tap targets, labels on everything tappable, WCAG text contrast) on sign-in, home, chat, feed, calls, shopping and every back-office tab, in light and dark mode | ✅ | `a11y_test`, plus checks inside `chat_test`, `social_test`, `calls_test` |
| Trying the phone app with TalkBack and VoiceOver, and a manual screen-reader pass on the web | ⛔ | Needs real devices and a person |
| Arrow-key navigation for tabs (WAI-ARIA tabs: one Tab stop, arrows, Home and End) | ✅ | Web e2e `a11yFlow` › keyboard on the admin tabs; the same component runs the business back office |

## Stage 10
Not started. See `plan.md`. The mini-app runtime is not implemented, and the apps say so.
