# Push notifications

Stage 4. The API queues a notification whenever a message arrives for someone, and delivers it to each of their signed-in devices through one of three push services:

| Provider | Used for | Needs | Status |
| --- | --- | --- | --- |
| Web Push (VAPID) | Browsers: Chrome, Edge, Firefox, Safari 16+ (on iPhone, only for web apps added to the home screen) | A key pair you generate yourself. No account anywhere | **Works today** in the web app |
| APNs | iPhone and iPad | An Apple Developer account and a `.p8` signing key | Server side built and tested against a local HTTP/2 stand-in. Needs credentials, and the iOS app still has to register |
| FCM (HTTP v1) | Android | A Firebase project and a service account | Server side built and tested against a local stand-in. Needs credentials, and the Android app still has to register |

Each provider is switched on by its environment variables and is independent of the others. With none set, devices can still register (so apps can ship first), nothing is queued, and `GET /v1/push/config` says which providers are live.

## How delivery works

1. **Registration.** A signed-in app calls `PUT /v1/push/devices/current` with its token (or, for browsers, its subscription). There is one registration per session. Signing out, or revoking that device from another one, stops delivery immediately because every send re-checks the session, and the worker deletes dead registrations within a minute. If the same token is registered by another account (someone else signs in on that phone), it moves to them.
2. **Queueing.** `push_jobs` is a transactional outbox: jobs are inserted in the same database transaction that saves the message, one per recipient device. If the API crashes after the commit, the notification is still sent; if the message is rolled back, no notification exists. Muted chats, people who switched notifications off, the sender's own devices, and dead tokens get no job.
3. **Delivery.** Every API instance runs a worker (`PUSH_WORKER_ENABLED`). It claims up to 50 due jobs with `FOR UPDATE SKIP LOCKED` plus a 60-second lease, so two instances never send the same job and a job held by a crashed worker is picked up again once its lease expires. The instance that saved a message wakes its own worker immediately; the others poll every `PUSH_WORKER_INTERVAL_MS`.
4. **Last-moment checks.** Just before sending, the worker drops the job (state `dropped`, with the reason) if the message was read on another device, deleted, hidden, the chat was muted, either person blocked the other, the person left the chat, switched notifications off or was signed out, or the job is older than `PUSH_TTL_SECONDS`.
5. **Results.** Success marks the job `sent`. A dead token (APNs `Unregistered`/`BadDeviceToken`, FCM `UNREGISTERED`, Web Push 404/410/403) disables the device and stops future jobs for it until the app registers again. Rate limits, outages and network errors are retried with exponential backoff (10 s doubling to a 30-minute cap, ±20% jitter, `Retry-After` honoured) up to `PUSH_MAX_ATTEMPTS` (8). Anything else fails the job without retrying. Finished jobs are deleted after 7 days.

Delivery receipts already exist from Stage 3: when a device receives a push it calls `POST /v1/conversations/:id/receipts` with `kind: "delivered"`, and the sender's ticks update. The web service worker does this. The native apps should do the same from their notification handlers.

## What a notification contains

Each person chooses in `PATCH /v1/me/notifications`:

- `preview: "full"` (default): sender name and message text. Attachments show as "Photo", "Voice message" and so on, never file names.
- `preview: "sender"`: sender name and "New message".
- `preview: "none"`: "Nexa" and "New message".
- `quietHours`: a daily window in the person's time zone. Notifications still arrive, without sound (APNs `interruption-level: passive`, Android channel `messages_quiet`, Web Push `silent`).

Every payload also carries `{ type: "message", conversationId, messageId, seq }` so the app can open the chat and fetch the message. The badge is the unread count across unmuted chats.

**Privacy:** chats are not end-to-end encrypted yet, so with `preview: "full"` the message text passes through Apple's, Google's or the browser vendor's push service (encrypted in transit). Web Push payloads are additionally encrypted for the browser (RFC 8291), so the push service only relays ciphertext. Once E2EE ships (ADR 0004), payloads should carry only ids and the app should decrypt locally.

## Configuration

### Web Push

```bash
pnpm --filter @nexa/api vapid-keys      # prints VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
```

Set both, plus `VAPID_SUBJECT` (a `mailto:` or `https:` contact that push services can use if something goes wrong). Keep the private key secret. Changing the key pair invalidates every browser subscription; the first send to each one fails, the device shows as stopped, and the web app offers to turn notifications on again (it replaces a subscription made with the old key).

Subscriptions are URLs that the API will POST to, so only real browser push services are accepted: `WEBPUSH_ALLOWED_HOSTS` defaults to `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.apple.com` and `notify.windows.com` (and their subdomains). This stops someone pointing the API at internal addresses.

### APNs (iOS)

1. In the Apple Developer portal, under Certificates, Identifiers & Profiles, Keys, create a key with "Apple Push Notifications service (APNs)" enabled and download the `.p8` file (it can only be downloaded once).
2. Set `APNS_KEY_ID` (the key's 10-character id), `APNS_TEAM_ID` (your team id), `APNS_BUNDLE_ID` (the app's bundle id) and `APNS_PRIVATE_KEY` (the `.p8` contents; `\n` escapes are fine in a single-line env file).
3. The app registers with `environment: "sandbox"` for development builds and `"production"` for TestFlight and App Store builds. The API picks the matching Apple host per device.

The same key works for every app in the team and does not expire.

### FCM (Android)

1. In the Firebase console, create a project, add the Android app, and download `google-services.json` for the app.
2. Under Project settings, Service accounts, generate a new private key. Set `FCM_SERVICE_ACCOUNT_JSON` to the downloaded file's contents (raw JSON or base64).
3. The app must create two notification channels: `messages` (default sound) and `messages_quiet` (no sound or vibration).

The legacy FCM server-key API is shut down; this uses HTTP v1 with a short-lived OAuth token minted from the service account.

### Worker settings

| Variable | Default | Notes |
| --- | --- | --- |
| `PUSH_WORKER_ENABLED` | `true` | Turn off on instances that should only serve requests. At least one instance must run it |
| `PUSH_WORKER_INTERVAL_MS` | `1000` | Polling interval when idle |
| `PUSH_MAX_ATTEMPTS` | `8` | Per job, including the first |
| `PUSH_TTL_SECONDS` | `86400` | Undelivered notifications older than this are dropped; also sent to the push service as the expiry |

`APNS_ENDPOINT` and `FCM_ENDPOINT` exist only for tests and are refused in staging and production.

## Still to do

- **iOS and Android apps:** request permission, get the token (APNs directly on iOS, FCM on Android), call `PUT /v1/push/devices/current`, handle taps, and send delivered receipts. This needs the Apple and Firebase projects above (`GoogleService-Info.plist` is not needed on iOS because APNs is used directly; `google-services.json` is needed on Android).
- Clearing a notification on other devices when a chat is read on one (silent "read" pushes).
- Group-chat notifications are formatted already ("Sender: text" under the group name) but groups arrive in Stage 5. Mentions do not yet bypass mute.
- Per-device delivered state. Receipts are per person, as in Stage 3.
- Metrics and alerting on queue depth and failure rates (Stage 10 monitoring).
