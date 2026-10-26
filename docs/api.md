# API reference (v1)

Base URL: `http://localhost:3000` locally. Requests and responses are JSON. Authenticated routes need `Authorization: Bearer <accessToken>`.

Errors always look like `{ "error": { "code": "…", "message": "…", "requestId": "…", "details"?: … } }`. Common codes: `validation_failed` (400), `invalid_token` (400), `media_rejected` (400), `unauthorized` / `invalid_credentials` (401), `forbidden` / `cannot_message` (403), `not_found` (404), `email_taken` / `username_taken` / `edit_window_passed` / `delete_window_passed` / `too_many_pins` / `media_not_ready` / `upload_missing` / `push_not_configured` (409), `rate_limited` (429, with a `Retry-After` header).

A token pair looks like `{ accessToken, refreshToken, expiresIn, sessionId }`.

## Health
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health/live` | Process is up |
| GET | `/health/ready` | `{ status, checks: { database, redis, storage } }`, 503 if degraded |

## Auth
| Method | Path | Auth | Body → Response |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | | `{ email, password (10+), username, displayName, deviceName? }` → 201 token pair. Sends a verification email |
| POST | `/v1/auth/login` | | `{ email, password, deviceName? }` → token pair, or `{ mfaRequired: true, mfaToken }` |
| POST | `/v1/auth/login/mfa` | | `{ mfaToken, code, deviceName? }` → token pair |
| POST | `/v1/auth/refresh` | | `{ refreshToken }` → new token pair (the old refresh token is now invalid) |
| POST | `/v1/auth/logout` | ✓ | → 204, ends this session |
| POST | `/v1/auth/verify-email` | | `{ token }` → `{ userId }` |
| POST | `/v1/auth/verify-email/resend` | ✓ | → 202 |
| POST | `/v1/auth/password/forgot` | | `{ email }` → 202 whether or not the account exists |
| POST | `/v1/auth/password/reset` | | `{ token, newPassword }` → 204, signs out all devices |
| POST | `/v1/auth/password/change` | ✓ | `{ currentPassword, newPassword }` → 204, signs out other devices |
| POST | `/v1/auth/mfa/setup` | ✓ | → `{ secret, otpauthUri }` |
| POST | `/v1/auth/mfa/confirm` | ✓ | `{ code }` → 204 |
| POST | `/v1/auth/mfa/disable` | ✓ | `{ password, code }` → 204 |

## Sessions
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/sessions` | ✓ | `[{ id, deviceName, userAgent, ip, createdAt, lastUsedAt, current }]` |
| DELETE | `/v1/sessions/:id` | ✓ | 204; 404 if not yours |

## Me and users
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/me` | ✓ | Profile, including `emailVerified` and `mfaEnabled` |
| PATCH | `/v1/me` | ✓ | Any of `displayName`, `bio`, `statusText`, `locale` |
| GET / PATCH | `/v1/me/privacy` | ✓ | `discoverableByEmail`, `discoverableByPhone`, `discoverableByUsername`, `whoCanMessage` (`everyone`/`contacts`/`nobody`), `showOnlineStatus`, `showReadReceipts` |
| GET | `/v1/me/export` | ✓ | JSON export of the account's data |
| POST | `/v1/me/deactivate` | ✓ | `{ password }` → 204; signing in again reactivates |
| DELETE | `/v1/me` | ✓ | `{ password }` → 204; permanent |
| GET | `/v1/users/:username` | ✓ | Public profile; 404 if hidden or blocked either way |

## Safety
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/blocks` | ✓ | Users you blocked |
| POST | `/v1/blocks` | ✓ | `{ userId }` → 204 |
| DELETE | `/v1/blocks/:userId` | ✓ | 204 |
| POST | `/v1/reports` | ✓ | `{ subjectType, subjectId, reason, details? }` → 201 |

## Conversations
Messages are **not end-to-end encrypted** yet; see [ADR 0004](adr/0004-end-to-end-encryption.md). Sync rules (ordering, retries, receipts) are in [`realtime.md`](realtime.md). Every route returns 404 for conversations you are not in.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/conversations` | ✓ | `?archived=false&limit=30&cursor=` → `{ conversations, nextCursor }`, newest activity first |
| POST | `/v1/conversations/direct` | ✓ | `{ userId }` → the one direct chat with that user (created if needed). 404 if the user doesn't exist or either has blocked the other |
| GET | `/v1/conversations/:id` | ✓ | `{ id, kind, lastSeq, lastMessage, unreadCount, mutedUntil, archived, peerId, members: [{ userId, username, displayName, role, lastDeliveredSeq, lastReadSeq }] }` |
| PATCH | `/v1/conversations/:id` | ✓ | Your own settings: `{ mutedUntil?: ISO date \| null, archived?: boolean }` |
| GET | `/v1/conversations/:id/messages` | ✓ | `?before=<seq>` (history, default newest) or `?after=<seq>` (catch-up), `limit` ≤ 100 → `{ messages (oldest first), hasMore }` |
| POST | `/v1/conversations/:id/messages` | ✓ | `{ clientId, kind?: text\|image\|video\|audio\|voice\|file, body?, mediaId?, replyToId?, mentions?: [userId] }` → 201 `{ message, duplicate: false }`, or 200 `{ message, duplicate: true }` for a repeated `clientId`. 403 `cannot_message` if blocked, or if the recipient only accepts messages from people they've replied to |
| GET | `/v1/conversations/:id/changes` | ✓ | `?since=<counter>&limit=200` → `{ changes, nextSince, hasMore }` |
| GET | `/v1/conversations/:id/pins` | ✓ | Pinned messages, newest pin first |
| POST | `/v1/conversations/:id/receipts` | ✓ | `{ kind: delivered\|read, seq }` → your positions (they only move forward) |

A message looks like `{ id, conversationId, seq, changeSeq, senderId, clientId, kind, body (null once deleted), media, replyTo: { id, seq, senderId, kind, preview, deleted }, forwarded, mentions, reactions: [{ userId, emoji }], editedAt, deletedAt, pinnedAt, pinnedBy, createdAt }`.

## Messages
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| PATCH | `/v1/messages/:id` | ✓ | `{ body }`. Sender only, within 15 minutes (409 `edit_window_passed`) |
| DELETE | `/v1/messages/:id` | ✓ | Delete for everyone. Sender only, within 48 hours. Clears the text, media, reactions and pin |
| POST | `/v1/messages/:id/hide` | ✓ | Delete for me → 204 |
| PUT | `/v1/messages/:id/reaction` | ✓ | `{ emoji }` (one emoji) or `{ emoji: null }` to remove. One reaction per person |
| PUT | `/v1/messages/:id/pin` | ✓ | `{ pinned }`. At most 10 per chat (409 `too_many_pins`) |
| POST | `/v1/messages/:id/forward` | ✓ | `{ conversationIds: [≤5], clientId }` → `{ messages }`, marked `forwarded` |
| GET | `/v1/messages/search` | ✓ | `?q=&conversationId=&limit=20&cursor=` → `{ results, nextCursor }`. Word-prefix match in your own chats, skipping deleted and hidden messages |
| GET | `/v1/presence` | ✓ | `?userIds=a,b` → `[{ userId, online, lastSeenAt }]`. `null` values when hidden (see `realtime.md`) |

## Media
Files go straight from the client to object storage. The API never handles the bytes.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/media/uploads` | ✓ | `{ kind, contentType, byteSize, fileName?, durationMs? (required for voice), width?, height? }` → 201 `{ media, upload: { method: "PUT", url, headers, expiresIn } }`. PUT exactly `byteSize` bytes with those headers within 15 minutes |
| POST | `/v1/media/:id/complete` | ✓ | Uploader only. Checks the stored size and the file signature against `contentType` → the media, `state: ready`. Mismatches are deleted (400 `media_rejected`). 409 `upload_missing` if nothing was uploaded |
| GET | `/v1/media/:id` | ✓ | `{ media, url, expiresIn: 300 }` for the uploader, or for members of a chat where it was sent (and not deleted). Otherwise 404 |

Allowed types: images (JPEG, PNG, GIF, WebP, HEIC, ≤ 20 MB), video (MP4, QuickTime, WebM, ≤ 100 MB), audio and voice notes (MP3, M4A/AAC, Ogg, WebM, WAV; audio ≤ 50 MB, voice ≤ 16 MB and ≤ 15 minutes), and files (PDF, plain text, ZIP, Word, Excel, PowerPoint, ≤ 100 MB). SVG, HTML and executables are refused.

## Realtime
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/realtime/tickets` | ✓ | `{ ticket, expiresIn: 60, path }`. Single use |
| GET (WebSocket) | `/v1/realtime?ticket=` | ticket | See [`realtime.md`](realtime.md) for frames and events |

## Push notifications
See [`push.md`](push.md) for how delivery works and how to configure each provider.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/push/config` | ✓ | `{ providers: { apns, fcm, webpush }, vapidPublicKey }`. Which services this server can deliver through, and the key browsers subscribe with (`null` when Web Push is not set up) |
| PUT | `/v1/push/devices/current` | ✓ | Registers this session's device, replacing any earlier one. One of `{ provider: "apns", token (hex), environment: "sandbox" \| "production" }`, `{ provider: "fcm", token }`, `{ provider: "webpush", endpoint, keys: { p256dh, auth } }` (the browser's `PushSubscription.toJSON()`). Web Push endpoints must be on a known browser push service. → the device. 30 per hour |
| DELETE | `/v1/push/devices/current` | ✓ | 204. Stops notifications to this device |
| POST | `/v1/push/devices/current/test` | ✓ | 202 `{ jobId }`. Queues a test notification to this device. 404 if not registered, 409 `push_not_configured` if the server lacks that provider's credentials. 5 per 10 minutes |
| GET | `/v1/push/devices` | ✓ | `[{ id, provider, deviceName, current, deliverable, disabledReason, lastDeliveredAt, registeredAt, updatedAt }]`. Tokens are never returned. `deliverable` is false when the token died or the server has no credentials for that provider |
| DELETE | `/v1/push/devices/:id` | ✓ | 204. Own devices only (404 otherwise) |
| GET | `/v1/me/notifications` | ✓ | `{ pushEnabled, preview: "full" \| "sender" \| "none", quietHours: { start: "HH:MM", end: "HH:MM", timeZone } \| null }` |
| PATCH | `/v1/me/notifications` | ✓ | Any of the fields above. `timeZone` is an IANA name; `start` and `end` must differ and may wrap past midnight |

Per-chat mute (`PATCH /v1/conversations/:id` with `mutedUntil`) also stops notifications for that chat.
