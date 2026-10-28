# API reference (v1)

Base URL: `http://localhost:3000` locally. Requests and responses are JSON. Authenticated routes need `Authorization: Bearer <accessToken>`.

Errors always look like `{ "error": { "code": "…", "message": "…", "requestId": "…", "details"?: … } }`. Common codes: `validation_failed` (400), `invalid_token` (400), `media_rejected` (400), `unauthorized` / `invalid_credentials` (401), `forbidden` / `cannot_message` / `cannot_add` / `admins_only` / `outranked` (403), `not_found` (404), `email_taken` / `username_taken` / `slug_taken` / `owner_cannot_leave` / `edit_window_passed` / `delete_window_passed` / `too_many_pins` / `media_not_ready` / `upload_missing` / `push_not_configured` (409), `rate_limited` (429, with a `Retry-After` header).

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
| GET / PATCH | `/v1/me/privacy` | ✓ | `discoverableByEmail`, `discoverableByPhone`, `discoverableByUsername`, `whoCanMessage` (`everyone`/`contacts`/`nobody`), `showOnlineStatus`, `showReadReceipts`, `privateAccount` (followers need approval; turning it off accepts pending requests), `whoCanAddToGroups` (`everyone`/`following`/`nobody`) |
| GET | `/v1/me/export` | ✓ | JSON export of the account's data. 5 an hour |
| POST | `/v1/me/deactivate` | ✓ | `{ password }` → 204; signing in again reactivates |
| DELETE | `/v1/me` | ✓ | `{ password }` → 204; permanent |
| GET | `/v1/users/:username` | ✓ | Public profile with `privateAccount`, `followerCount`, `followingCount` and `relationship: { following: none\|pending\|active, followsYou }`; 404 if hidden or blocked either way |

## Safety
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/blocks` | ✓ | Users you blocked |
| POST | `/v1/blocks` | ✓ | `{ userId }` → 204 |
| DELETE | `/v1/blocks/:userId` | ✓ | 204 |
| POST | `/v1/reports` | ✓ | `{ subjectType: user\|message\|post\|comment\|story\|community, subjectId, reason, details? }` → 201 |

## Conversations
Messages are **not end-to-end encrypted** yet; see [ADR 0004](adr/0004-end-to-end-encryption.md). Sync rules (ordering, retries, receipts) are in [`realtime.md`](realtime.md). Every route returns 404 for conversations you are not in.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/conversations` | ✓ | `?archived=false&limit=30&cursor=` → `{ conversations, nextCursor }`, newest activity first |
| POST | `/v1/conversations/direct` | ✓ | `{ userId }` → the one direct chat with that user (created if needed). 404 if the user doesn't exist or either has blocked the other |
| GET | `/v1/conversations/:id` | ✓ | `{ id, kind, title, group (null for direct chats), lastSeq, lastMessage, unreadCount, mutedUntil, archived, peerId, members: [{ userId, username, displayName, role, lastDeliveredSeq, lastReadSeq }] }` |
| PATCH | `/v1/conversations/:id` | ✓ | Your own settings: `{ mutedUntil?: ISO date \| null, archived?: boolean }` |
| GET | `/v1/conversations/:id/messages` | ✓ | `?before=<seq>` (history, default newest) or `?after=<seq>` (catch-up), `limit` ≤ 100 → `{ messages (oldest first), hasMore }` |
| POST | `/v1/conversations/:id/messages` | ✓ | `{ clientId, kind?: text\|image\|video\|audio\|voice\|file, body?, mediaId?, replyToId?, mentions?: [userId] }` → 201 `{ message, duplicate: false }`, or 200 `{ message, duplicate: true }` for a repeated `clientId`. 403 `cannot_message` if blocked, or if the recipient only accepts messages from people they've replied to |
| GET | `/v1/conversations/:id/changes` | ✓ | `?since=<counter>&limit=200` → `{ changes, nextSince, hasMore }` |
| GET | `/v1/conversations/:id/pins` | ✓ | Pinned messages, newest pin first |
| POST | `/v1/conversations/:id/receipts` | ✓ | `{ kind: delivered\|read, seq }` → your positions (they only move forward) |

A group's `group` field is `{ description, sendPolicy, infoPolicy, addPolicy (each everyone|admins), myRole }`.

### Groups
Members only see messages sent after they joined. Membership and settings changes appear in the chat as messages with `kind: "system"` and a `system` object (`group_created`, `members_added`, `member_removed`, `member_left`, `role_changed`, `group_updated`), and members get a `conversation.changed` event; people who are removed get `conversation.removed`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/conversations/groups` | ✓ | `{ title (1-100), description?, memberIds: [≤255] }` → 201 conversation. You are the owner. 403 `cannot_add` with `details.userIds` when someone's "who can add me" setting or a block stops it. 20 per hour |
| PATCH | `/v1/conversations/:id/group` | ✓ | Any of `title`, `description`, `sendPolicy`, `infoPolicy`, `addPolicy`. Policies are admin-only; title and description follow `infoPolicy` |
| POST | `/v1/conversations/:id/members` | ✓ | `{ userIds }` → conversation. Admins, or anyone when `addPolicy` is `everyone`. At most 256 members |
| PATCH | `/v1/conversations/:id/members/:userId` | ✓ | `{ role: owner\|admin\|member }`. Admins promote members; only the owner demotes admins or hands over ownership |
| DELETE | `/v1/conversations/:id/members/:userId` | ✓ | Remove someone (admins remove members, the owner removes anyone), or leave when it is your own id. When the owner leaves, the longest-serving admin (or else member) becomes owner |

Sending to an admins-only group as a member gives 403 `admins_only`.

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
| GET | `/v1/media/:id` | ✓ | `{ media, url, expiresIn: 300 }` for the uploader, for members of a chat where it was sent (and not deleted), or for anyone allowed to see the post or story it is attached to. Otherwise 404 |

Allowed types: images (JPEG, PNG, GIF, WebP, HEIC, ≤ 20 MB), video (MP4, QuickTime, WebM, ≤ 100 MB), audio and voice notes (MP3, M4A/AAC, Ogg, WebM, WAV; audio ≤ 50 MB, voice ≤ 16 MB and ≤ 15 minutes), and files (PDF, plain text, ZIP, Word, Excel, PowerPoint, ≤ 100 MB). SVG, HTML and executables are refused.

## Social
Who can see a post, story, comment or community is decided by the same rules on every route, including media downloads. People who blocked each other never see each other's content. Anything you can't see is a 404.

A post is `{ id, author: { id, username, displayName }, community: { id, slug, name, kind } | null, audience: public|followers|only_me, body, media: [...], likeCount, commentCount, liked, createdAt, editedAt, removed: { at, reason } | null, shared: post | { id, unavailable: true } | null }`. Lists return `{ posts, nextCursor }`; pass `?cursor=` for the next page.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/users/:id/follow` | ✓ | → `{ following: active\|pending, followsYou }`. Pending for private accounts. 200 per day |
| DELETE | `/v1/users/:id/follow` | ✓ | Unfollow, or withdraw a request → 204 |
| GET | `/v1/users/:id/followers`, `/v1/users/:id/following` | ✓ | `{ users, nextCursor }`. 404 for a private account you don't follow |
| GET | `/v1/me/follow-requests` | ✓ | `{ users }` waiting for your approval |
| POST | `/v1/me/follow-requests/:userId` | ✓ | `{ approve }` → 204 |
| DELETE | `/v1/me/followers/:userId` | ✓ | Remove a follower → 204 |
| GET | `/v1/feed` | ✓ | Your posts, people you follow and communities you belong to, newest first |
| GET | `/v1/users/:id/posts` | ✓ | That person's posts you are allowed to see |
| POST | `/v1/posts` | ✓ | `{ clientId, body? (≤5000), audience?, mediaIds? (≤10 ready images or videos you uploaded), sharedPostId?, communityId? }` → 201 `{ post, duplicate: false }` or 200 `{ post, duplicate: true }` for a repeated `clientId`. Needs a body, media or a shared post. Community posts take the community's visibility. 30 per hour |
| GET / PATCH / DELETE | `/v1/posts/:id` | ✓ | Read; edit `{ body?, audience? }` (author only); delete (author only, frees its files) |
| PUT | `/v1/posts/:id/like` | ✓ | `{ liked }` → `{ liked, likeCount }` |
| GET | `/v1/posts/:id/likes` | ✓ | `{ users }`, without people you blocked or who blocked you |
| GET / POST | `/v1/posts/:id/comments` | ✓ | List oldest first `{ comments, nextCursor }`; add `{ body (1-2000) }` → 201 comment. 120 per hour |
| DELETE | `/v1/comments/:id` | ✓ | Comment author, post author, or a community moderator → 204 |
| POST | `/v1/posts/:id/moderation` | ✓ | Community moderators and above: `{ removed, reason? }` → 204. Recorded in the audit log. Removed posts stay visible to their author with the reason |
| GET | `/v1/stories` | ✓ | `{ groups: [{ author, stories, allViewed }] }` for you and people you follow, unseen first |
| POST | `/v1/stories` | ✓ | `{ kind: text\|image\|video, body? (≤500), background? (#RRGGBB), mediaId?, audience?: public\|followers (default) }` → 201. Lasts 24 hours. 50 per day |
| GET / DELETE | `/v1/stories/:id` | ✓ | Read, or delete your own early |
| POST | `/v1/stories/:id/views` | ✓ | Mark seen → 204 |
| GET | `/v1/stories/:id/views` | ✓ | Author only: `{ viewers }` |
| GET | `/v1/users/:id/stories` | ✓ | That person's live stories you may see |
| POST | `/v1/communities` | ✓ | `{ slug, name, description?, kind?: community\|channel, visibility?: public\|private }` → 201. 409 `slug_taken`. 5 per day |
| GET | `/v1/communities` | ✓ | `?q=&limit=` → `{ communities }`. Without `q`, the ones you belong to or asked to join; with `q`, any community whose name or address matches (private ones show only their name and description), largest first |
| GET | `/v1/communities/:idOrSlug` | ✓ | `{ id, slug, kind, name, description, visibility, memberCount, membership: { role, state } \| null, createdAt }`. A private community's name and description are visible so people can ask to join; its posts and members are not. 404 for people banned from it |
| PATCH / DELETE | `/v1/communities/:id` | ✓ | Edit (admins) or delete (owner) |
| POST | `/v1/communities/:id/join` | ✓ | → the community. Public: active member; private: pending until approved. Banned people get 403 |
| DELETE | `/v1/communities/:id/membership` | ✓ | Leave → 204. 409 `owner_cannot_leave` (hand over first) |
| GET | `/v1/communities/:id/members` | ✓ | `?state=active\|pending\|banned` → `{ members }`. Members only; pending and banned lists are for moderators |
| PATCH | `/v1/communities/:id/members/:userId` | ✓ | `{ role?, state?: active (approve) \| banned }`. You can only act on people ranked below you (403 `outranked`); handing over ownership is owner-only |
| DELETE | `/v1/communities/:id/members/:userId` | ✓ | Remove someone ranked below you → 204 |
| GET | `/v1/communities/:id/posts` | ✓ | Posts in the community, for anyone who may see it. In channels only admins and the owner can post |

## Realtime
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/realtime/tickets` | ✓ | `{ ticket, expiresIn: 60, path }`. Single use |
| GET (WebSocket) | `/v1/realtime?ticket=` | ticket | See [`realtime.md`](realtime.md) for frames and events |

## Calls
See [`calls.md`](calls.md). Starting, answering and signalling happen on the WebSocket (`call.*` frames in [`realtime.md`](realtime.md)), because each call is tied to one connection per side.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/calls` | ✓ | Call history, newest first: `{ calls: [call + { direction: "incoming" \| "outgoing", peer: { id, username, displayName } }], nextCursor }`. `limit` (1–100, default 30), `cursor` |
| GET | `/v1/calls/ice-servers` | ✓ | `{ iceServers: [{ urls, username?, credential? }], iceTransportPolicy: "all" \| "relay", relay, expiresAt }`. Pass straight to `RTCPeerConnection`. TURN credentials are per user and short-lived. 60 per 10 minutes |
| GET | `/v1/calls/active` | ✓ | `{ call }`: the call you are on or being rung for, or `null`. Devices check it after connecting |
| GET | `/v1/calls/:id` | ✓ | The call. 404 unless you are the caller or callee |
| POST | `/v1/calls/:id/decline` | ✓ | The callee declines while it rings. 409 `call_not_ringing` otherwise |
| POST | `/v1/calls/:id/hangup` | ✓ | `{ failed?: boolean }`. Either side ends the call; repeating it is harmless |

A call is `{ id, conversationId, callerId, calleeId, media: "audio" \| "video", state: "ringing" \| "accepted" \| "connected" \| "ended", endReason, endedBy, callerConnectionId, calleeConnectionId, callerReconnecting, calleeReconnecting, createdAt, answeredAt, connectedAt, endedAt, durationSeconds }`. `endReason` is one of `completed`, `cancelled`, `missed`, `declined`, `busy`, `failed`, `connection_lost`. Each ended call also adds a `system` message to the chat: `{ type: "call", callId, media, outcome, durationSeconds }`.

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

## Businesses
Business accounts, staff roles, the catalogue, orders and bookings. See [`business.md`](business.md) for the role matrix and order and booking rules. `:ref` is a business id or handle; changes take the id. Back-office routes return 404 to people who are not active staff, and 403 when your role lacks the permission.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/businesses` | ✓ | `{ handle, name, category, timeZone (IANA), currency (ISO 4217), description?, contactEmail?, phone? (E.164), address? }` → 201 business; you are its owner. 409 `handle_taken`. 3 per day |
| GET | `/v1/businesses` | ✓ | Search active businesses: `q`, `category`, `limit` (1–50). Verified first |
| GET | `/v1/me/businesses` | ✓ | Businesses you work at, plus invitations waiting for you |
| GET | `/v1/businesses/:ref` | ✓ | `{ id, handle, name, description, category, contactEmail, phone, address, timeZone, currency, ordersEnabled, bookingsEnabled, verified, state, suspensionReason (staff only), myRole, permissions, invited, payments: { online, inPerson } }`. `payments.online` is true once the business can take card payments. Suspended businesses are 404 for customers |
| PATCH | `/v1/businesses/:id` | ✓ | `business.edit`. Any of the fields above (not `handle` or `currency`), plus `ordersEnabled`, `bookingsEnabled`, `inPersonPayments`. 409 `business_suspended` while suspended; `inPersonPayments: false` is 409 `online_payments_unavailable` until card payments work |
| DELETE | `/v1/businesses/:id` | ✓ | Owner. Closes it: open orders and future bookings are cancelled |
| GET | `/v1/businesses/:ref/hours` | ✓ | `{ hours: [{ weekday (0 = Sunday), opens: "HH:MM", closes: "HH:MM" }] }` in the business's time zone |
| PUT | `/v1/businesses/:id/hours` | ✓ | `business.edit`. Replaces all opening hours. Several rows per day are allowed; they must not overlap |
| GET | `/v1/businesses/:id/staff` | ✓ | Staff only. `{ staff: [{ user, role: "owner" \| "manager" \| "staff", state: "invited" \| "active", since }] }` |
| POST | `/v1/businesses/:id/staff` | ✓ | `staff.manage`. `{ username, role: "manager" \| "staff" }` invites someone. Owners invite managers and staff; managers invite staff. 409 `already_staff`. 50 per day |
| POST | `/v1/businesses/:id/staff/accept` | ✓ | Accept your invitation → the business |
| PATCH | `/v1/businesses/:id/staff/:userId` | ✓ | `{ role }`. Only roles below your own, never your own |
| DELETE | `/v1/businesses/:id/staff/:userId` | ✓ | Remove someone below you, or leave / decline yourself. 409 `owner_cannot_leave` |
| POST | `/v1/businesses/:id/transfer` | ✓ | Owner. `{ userId }` of an active manager, who becomes owner; you become a manager |
| GET | `/v1/businesses/:ref/items` | ✓ | `{ items: [{ id, name, description, priceMinor, currency, available, stock, position }] }`. `all=true` (staff) includes hidden and sold-out items |
| POST | `/v1/businesses/:id/items` | ✓ | `catalogue.manage`. `{ name, priceMinor, description?, available?, stock? (null = not tracked), position? }`. Up to 500 items, or 5,000 with a plan that has `catalogue.extra`. 409 `catalogue_full` |
| PATCH | `/v1/businesses/:id/items/:itemId` | ✓ | `catalogue.manage`. Any item field. Past orders keep their own copy of name and price |
| DELETE | `/v1/businesses/:id/items/:itemId` | ✓ | `catalogue.manage`. Archives the item |
| POST | `/v1/businesses/:ref/orders` | ✓ | `{ clientId, items: [{ itemId, quantity (1–99) }] (1–50 lines), note?, payment?: "pay_in_person" \| "online" }` → 201 order, or 200 with the first order for a repeated `clientId`. Prices come from the catalogue. 409 `orders_closed`, `item_unavailable` (`details.itemId`), `online_payments_unavailable`, `nothing_to_pay`, `in_person_not_accepted`. An online order starts as `pending_payment`; pay it with `POST /v1/orders/:id/checkout`. 30 per hour |
| GET | `/v1/businesses/:id/orders` | ✓ | `orders.view`. `status` (comma-separated), `limit` (1–100), `cursor`. Newest first, with `customer` (id, username, display name only) |
| GET | `/v1/orders` | ✓ | Orders you placed, newest first. `limit`, `cursor` |
| GET | `/v1/orders/:id` | ✓ | The customer or the business's staff; 404 for anyone else |
| POST | `/v1/orders/:id/cancel` | ✓ | The customer, while `pending_payment` or `placed`. A paid order is refunded in full. 409 `order_in_progress` after that |
| POST | `/v1/orders/:id/status` | ✓ | `orders.manage`. `{ status, reason? }`. `placed → accepted \| rejected`, `accepted → ready \| cancelled`, `ready → completed \| cancelled`. 409 `invalid_transition`. Rejected and cancelled orders give their stock back, and paid ones are refunded in full. `pending_payment` orders can't be moved by staff |
| GET | `/v1/businesses/:ref/services` | ✓ | `{ services: [{ id, name, description, durationMinutes, priceMinor, currency, capacity, active }] }`. `all=true` (staff) includes inactive ones |
| POST | `/v1/businesses/:id/services` | ✓ | `services.manage`. `{ name, durationMinutes (5–480), priceMinor?, capacity? (1–100, people at once), description?, active? }` |
| PATCH / DELETE | `/v1/businesses/:id/services/:serviceId` | ✓ | `services.manage`. Delete archives it; existing bookings stay |
| GET | `/v1/businesses/:ref/services/:serviceId/slots` | ✓ | `date=YYYY-MM-DD` (the business's local date) → `{ date, timeZone, slots: [{ startsAt, endsAt, remaining }] }`. Steps of the service's length inside opening hours, in the future, up to 90 days ahead, with room left |
| POST | `/v1/businesses/:ref/bookings` | ✓ | `{ serviceId, startsAt (one of the slots), clientId, note? }` → 201 booking, or 200 for a repeated `clientId`. 409 `slot_unavailable`, `slot_full`, `bookings_closed`. 20 per hour |
| GET | `/v1/businesses/:id/bookings` | ✓ | `bookings.view`. `from`, `to` (ISO times, up to 62 days apart) |
| GET | `/v1/bookings` | ✓ | Your bookings. `upcoming=false` for all of them, newest first |
| GET | `/v1/bookings/:id` | ✓ | The customer or the business's staff |
| POST | `/v1/bookings/:id/cancel` | ✓ | The customer, or staff with `bookings.manage`, before it starts. 409 `booking_started`, `booking_closed` |
| POST | `/v1/bookings/:id/outcome` | ✓ | `bookings.manage`. `{ status: "completed" \| "no_show" }`, after the start. 409 `booking_not_started` |

An order is `{ id, business: { id, handle, name }, customer? (staff view only), status, statusReason, fulfilment: "pickup", payment: "pay_in_person" \| "online", paymentStatus: null \| "unpaid" \| "paid" \| "partially_refunded" \| "refunded" \| "cancelled", refundedMinor, note, items: [{ itemId, name, unitPriceMinor, quantity }], totalMinor, currency, createdAt, updatedAt }`. Staff don't see `pending_payment` orders. A booking is `{ id, business: { id, handle, name, timeZone }, service: { id, name }, customer? , startsAt, endsAt, status: "confirmed" \| "cancelled" \| "completed" \| "no_show", cancelledBy, note, createdAt }`. Money is always in minor units of the business's currency.

## Payments
Card payments for orders, refunds, payouts and business plans, through Stripe. See [`payments.md`](payments.md). When the server has no provider (`PAYMENTS_PROVIDER=none`) these return 409 `payments_not_enabled`. Provider failures are 502 `payment_provider_unavailable` (safe to retry) or 409 `payment_provider_refused`.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/payments/webhooks/stripe` | Signature | Stripe events. Needs a valid `Stripe-Signature`, else 400 `invalid_signature`; events from the other mode are 400 `livemode_mismatch`. → `{ received: true, duplicate }` |
| GET | `/v1/businesses/:id/payments/account` | ✓ | `payments.view`. `{ enabled, provider, connected, country, chargesEnabled, payoutsEnabled, detailsSubmitted, onlinePayments, updatedAt }`, refreshed from Stripe |
| POST | `/v1/businesses/:id/payments/account` | ✓ | `payments.manage` (owner). `{ country }` (two letters) → `{ url, account }`: Stripe's onboarding page. Call again to continue. 409 `account_mode_mismatch` |
| GET | `/v1/businesses/:id/payments` | ✓ | `payments.view`. `{ payments, totals: [{ currency, paidMinor, refundedMinor, feesMinor }], nextCursor }`. `limit`, `cursor` |
| POST | `/v1/orders/:id/checkout` | ✓ | The customer, while `pending_payment` → `{ url, expiresAt }`. The same page while it is open. 409 `not_online`, `already_paid`, `payment_closed` |
| GET | `/v1/orders/:id/payment` | ✓ | The customer or staff with `orders.view` → `{ payment: null \| { id, orderId, status, amountMinor, refundedMinor, refundableMinor, feeMinor, currency, createdAt, paidAt, refunds: [{ id, amountMinor, status, origin, reason, createdAt }] } }` |
| POST | `/v1/orders/:id/refunds` | ✓ | `orders.refund`. `{ clientId, amountMinor?, reason? }`; no amount refunds what's left → 201 `{ refund, payment }`, or the first refund for a repeated `clientId`. 409 `not_paid`, `refund_too_large` (`details.refundableMinor`) |
| GET | `/v1/me/payments` | ✓ | Your card payments, newest first |
| GET | `/v1/plans` | ✓ | Plans on sale: `{ plans: [{ id, code, name, description, priceMinor, currency, interval, entitlements }] }` |
| GET | `/v1/businesses/:id/subscription` | ✓ | Staff. `{ subscription: null \| { status, plan, currentPeriodEnd, cancelAtPeriodEnd }, entitlements, limits: { staff, catalogue } }` |
| POST | `/v1/businesses/:id/subscription` | ✓ | `billing.manage` (owner). `{ planCode, clientId }` → `{ url }`: Stripe Checkout. 409 `already_subscribed` |
| DELETE | `/v1/businesses/:id/subscription` | ✓ | `billing.manage`. Cancels at the end of the period |
| POST | `/v1/businesses/:id/subscription/resume` | ✓ | `billing.manage`. Undoes that |
| POST | `/v1/businesses/:id/billing-portal` | ✓ | `billing.manage` → `{ url }`: Stripe's page for the card and invoices |

## Integrations
The integration catalogue (phase 1 of mini-apps, ADR 0006). Partners can't call our API yet; these endpoints record what each person allowed.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/integrations` | ✓ | Live integrations: `{ integrations: [{ id, slug, name, description, category, developer: { name }, homepageUrl, scopes: [{ scope, description }], version, state, grant }] }`. `category` filter |
| GET | `/v1/integrations/:slug` | ✓ | One integration. Also returned when it was switched off but you still have a grant (`grant.active: false`) |
| PUT | `/v1/integrations/:slug/connection` | ✓ | `{ scopes }`, a subset of what it asks for. Replaces your grant. 404 unless live |
| DELETE | `/v1/integrations/:slug/connection` | ✓ | Revoke |
| GET | `/v1/me/integrations` | ✓ | What you connected, with the scopes you granted |

Scopes: `profile.basic`, `email`, `orders.read`, `bookings.read`, `notifications.send`. Nothing can grant access to messages, contacts or tokens.

## Admin
Platform staff only. Every route needs a `platform_staff` role, two-step verification turned on, and a session opened with a two-step code in the last `ADMIN_SESSION_MAX_HOURS` (default 12). Refusals are 403 with `not_platform_staff`, `mfa_required`, `mfa_reauth_required` or `admin_only`. See [`admin.md`](admin.md).

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/v1/admin/overview` | moderator | `{ role, reports: { open, inReview, childSafety }, users: { active, suspended }, businesses, liveIntegrations }` |
| GET | `/v1/admin/reports` | moderator | `status=open\|closed`, `subjectType`, `limit`, `offset`. Open: child safety first, then oldest first |
| GET | `/v1/admin/reports/:id` | moderator | The report with `subject` (the reported thing as it is now, or `null`) and `related` reports on the same subject. Only the reported message is shown, never the rest of the chat. Viewing is audited |
| POST | `/v1/admin/reports/:id/claim` | moderator | Marks it `in_review` and assigns it to you |
| POST | `/v1/admin/reports/:id/resolve` | moderator | `{ decision: "dismiss" \| "action", removeContent?, suspendAuthor?, note? }`. Closes every open report on the same subject. Removing a business or integration needs `admin`. 409 `content_gone`, `report_closed`; 403 `staff_protected` |
| GET | `/v1/admin/users` | moderator | `q` (username prefix, exact email or id). Email is shown to admins only |
| POST | `/v1/admin/users/:id/suspend` | moderator | `{ reason }`. Signs them out everywhere and removes push devices. Sign-in then fails with 403 `account_suspended` |
| POST | `/v1/admin/users/:id/unsuspend` | moderator | `{ reason? }` |
| GET | `/v1/admin/businesses` | admin | `q`, `state`, `limit` |
| POST | `/v1/admin/businesses/:id/actions` | admin | `{ action: "verify" \| "unverify" \| "suspend" \| "unsuspend", reason? }` |
| GET / POST | `/v1/admin/integrations` | admin | List (with connection counts), or create a draft: `{ slug, name, category, developerName, developerContact, homepageUrl (https), scopes, description?, version? }` |
| PATCH | `/v1/admin/integrations/:id` | admin | Asking for more scopes sends a live integration back to `draft`; fewer scopes trims every grant |
| POST | `/v1/admin/integrations/:id/state` | admin | `{ state: "live" \| "disabled" \| "draft", reason? }`. `disabled` is the kill switch |
| GET / POST | `/v1/admin/staff` | admin | List platform staff, or `{ username }` to add a moderator |
| GET | `/v1/admin/payments` | admin | Every card payment, with its business. `status`, `limit`, `cursor` |
| GET | `/v1/admin/ledger` | admin | `{ balances: [{ account, currency, balanceMinor }], check: { ok, transactions, problems: [{ type, id, problem }] } }` |
| GET / POST | `/v1/admin/plans` | admin | All plans, or create one as `draft`: `{ code, name, priceMinor, currency, interval: "month" \| "year", entitlements, description? }`. Makes the Stripe product and price. 409 `plan_code_taken` |
| POST | `/v1/admin/plans/:id/state` | admin | `{ state: "active" \| "retired" }` |
| DELETE | `/v1/admin/staff/:userId` | admin | Remove a moderator (admins are removed from the command line) |
| GET | `/v1/admin/audit` | admin | `action` (prefix), `before` (entry id), `limit` (1–200). Newest first, without IP addresses |
