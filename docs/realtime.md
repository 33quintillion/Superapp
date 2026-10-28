# Messaging sync and the realtime protocol

This is how clients keep chats correct across reconnects, retries and several devices. The REST endpoints are listed in [`api.md`](api.md).

**Messages are not end-to-end encrypted.** They are encrypted in transit (TLS, configured at deployment) and stored readable by the server. See [ADR 0004](adr/0004-end-to-end-encryption.md) for why, and what changes when E2EE arrives.

## Ordering and the change counter

Every conversation has one counter, `conversations.last_seq`. Each change takes the next value while holding the conversation's row lock, so values are committed in order with no gaps. A change is a new message, an edit, a delete, a reaction, a pin, or a "delete for me".

- `message.seq` is the value the message got when it was sent. It gives the display order and is never reused.
- `message.changeSeq` is the value of the latest change to that message.

A device remembers, for each conversation it has open, the highest counter value it has applied (`since`). Two rules keep it correct:

1. **Live events.** Each `message.created` or `message.updated` event carries the message's `changeSeq`. If it equals `since + 1`, apply it and move `since` forward. If it is larger, something was missed, so call the change feed.
2. **After every (re)connect** (the `ready` frame), call the change feed for every open conversation.

The change feed is `GET /v1/conversations/:id/changes?since=N`. It returns every message whose `changeSeq > N` in change order, plus `nextSince` and `hasMore`. A message hidden for you comes back as `{ id, seq, changeSeq, hidden: true }`. When `hasMore` is false, `nextSince` is the conversation's current counter value. Store it.

Because a later change replaces a message's `changeSeq`, the feed returns each message once, in its current state, rather than a log of every edit.

## Sending, retries and duplicates

The sending device picks a `clientId` (8 to 64 characters from `A-Z a-z 0-9 _ -`) for each new message and keeps the message in a local outbox until it is acknowledged. The server stores at most one message per `(conversation, sender, clientId)`:

- The first send returns `201` (REST) or an `ack` with `duplicate: false`.
- Any repeat returns the original message with `duplicate: true` (`200` over REST). This includes concurrent repeats.

So the client can re-send everything in its outbox after every reconnect without creating duplicates. Errors such as `cannot_message` or `validation_failed` are final: the message is marked as failed and the user can choose to retry. `rate_limited` and `internal_error` are worth retrying.

## Receipts

Each member has `lastDeliveredSeq` and `lastReadSeq`. Both only move forward, and both are clamped to the conversation's counter. Marking something read also marks it delivered. Sending a message marks the sender's own positions. A message is delivered or read for a member when that member's position is at least the message's `seq`.

Read positions are shared only when **both** people have read receipts switched on. If either has them off, the other person's `lastReadSeq` shows as `null`. Delivery is always shown.

## Presence and typing

- A user is online while at least one of their sockets is connected. Presence lives in Redis with a timeout, so a crashed server does not leave people online.
- Online status and last seen are shown only between people who share a chat, are not blocked, and **both** have "show online status" switched on. `GET /v1/presence?userIds=…` returns `online: null` and `lastSeenAt: null` when hidden.
- Typing is relayed and never stored. Clients send `typing: true` while typing (the server drops repeats within 2 s) and `typing: false` when they stop. Receivers expire it after about 6 s. Typing is not relayed across a block.

## The WebSocket

1. `POST /v1/realtime/tickets` (authenticated) returns `{ ticket, expiresIn: 60, path: "/v1/realtime" }`. A ticket works once.
2. Open `ws(s)://<api>/v1/realtime?ticket=<ticket>`. A missing, used or expired ticket, or a signed-out session, gets HTTP 401. A browser `Origin` outside `CORS_ORIGINS` gets 403. A person who already has 20 sockets open on that API instance gets 429.

The ticket keeps the access token out of URLs and logs. On the web, only the server layer holds tokens. It asks for a ticket, and the browser opens the socket with it.

The server re-checks the session every `WS_SESSION_RECHECK_SECONDS` (30 s by default). Signing a device out closes its socket with code `4401`.

### Client → server frames
| Frame | Reply |
| --- | --- |
| `{ type: "ping", ref? }` | `{ type: "pong", ref }` |
| `{ type: "send", ref?, conversationId, message: { clientId, kind?, body?, mediaId?, replyToId?, mentions? } }` | `{ type: "ack", ref, data: { message, duplicate } }` |
| `{ type: "receipt", ref?, conversationId, kind: "delivered" \| "read", seq }` | `{ type: "ack", ref, data: { conversationId, userId, lastDeliveredSeq, lastReadSeq } }` |
| `{ type: "typing", conversationId, typing }` | none |
| `{ type: "call.start", ref?, conversationId, media: "audio" \| "video" }` | `ack` with the call (`ringing`, or `ended` with `busy`). Errors: `cannot_call`, `already_in_call`, `group_calls_unsupported`, `not_found`. 20 per 10 minutes |
| `{ type: "call.accept", ref?, callId }` | `ack` with the call, now bound to this connection. `call_not_ringing` if it ended or another device answered |
| `{ type: "call.decline", ref?, callId }` | `ack` with the ended call |
| `{ type: "call.hangup", ref?, callId, failed? }` | `ack` with the ended call (repeat-safe) |
| `{ type: "call.connected", ref?, callId }` | `ack`. Media is flowing; starts the call clock |
| `{ type: "call.signal", ref?, callId, signal }` | `ack` only when `ref` is given. `signal` is `{ kind: "offer" \| "answer", sdp }` or `{ kind: "candidate", candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } \| null }`. Only from the connection bound to the call (`call_not_active` otherwise) |
| `{ type: "call.resume", ref?, callId }` | `ack` with the call, now bound to this new connection. Used after a reconnect (`call_ended` if it is over) |

A frame that fails gets `{ type: "error", ref, error: { code, message, details? } }`, and the connection stays open. Clients use their `clientId` as the `ref` for sends.

### Server → client events
| Event | `data` |
| --- | --- |
| `ready` | `{ connectionId, userId, heartbeatSeconds }`, sent once after connecting |
| `message.created`, `message.updated` | the message, as REST returns it |
| `message.hidden` | `{ id, conversationId, changeSeq }`, sent only to your own devices |
| `receipt` | `{ conversationId, userId, lastDeliveredSeq, lastReadSeq }` (`lastReadSeq` may be `null`, see above) |
| `typing` | `{ conversationId, userId, typing }` |
| `presence` | `{ userId, online, lastSeenAt }` |
| `conversation.updated` | `{ id, mutedUntil, archived }`, sent only to your own devices |
| `conversation.changed` | `{ id }`. A group's members, roles or settings changed; fetch `GET /v1/conversations/:id` again. New members also get it, so a group appears on their devices |
| `conversation.removed` | `{ id }`. You were removed from a group or left it on another device; drop it from the list |
| `call.updated` | The call (see [`calls.md`](calls.md)), to every device of both people on each change: ringing, answered, connected, someone reconnecting, ended |
| `call.signal` | `{ callId, from, signal }`, only to the one connection taking part on the receiving side |
| `order.updated`, `booking.updated` | The order or booking, as REST returns it to the customer, when the business (or you, on another device) changes it |
| `business.order.created`, `business.order.updated`, `business.booking.created`, `business.booking.updated` | The order or booking with its `customer`, to every active staff member of the business |
| `business.dispute.updated` | A dispute on one of the business's payments (see [`payments.md`](payments.md#disputes)), to owners and managers |

Events go to every device of every member, including the device that made the change. Clients deduplicate by message id.

### Limits and close codes
- Frames are JSON text, at most 64 KB. Each connection gets 200 frames per 10 s, then it is closed with `4429`.
- The server pings every `WS_HEARTBEAT_SECONDS` (25 s) and drops sockets that stop answering. Clients should also send an app-level `ping` and reconnect if nothing arrives for about 45 s, because a dead network can leave a socket that looks open.
- A client that cannot keep up (more than 4 MB buffered) is closed with `4408`. It catches up from the change feed after it reconnects.
- `1001` means the server is shutting down. Reconnect with backoff.

## Fan-out across servers

Each user has a Redis pub/sub channel. A server subscribes only to the users who have a socket open on it, and every write publishes to the channels of the conversation's members after it commits. Pub/sub delivery is best-effort, which is safe because Postgres and the change feed are the source of truth. Before a large launch, load-test this (Stage 9) and decide whether to move to Redis Streams or a broker with per-device queues.

## Not done yet
- Push notifications reach browsers today. iPhone and Android need APNs and FCM credentials and app-side registration (see [`push.md`](push.md)).
- Per-device delivery state. Receipts are per user, not per device.
- Outboxes are kept in memory. A send that is still pending when the app is killed is lost and has to be typed again.
