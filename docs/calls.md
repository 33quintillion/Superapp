# Voice and video calls

One-to-one voice and video calls use WebRTC. The API handles signalling, call state and history. Audio and video go **directly between the two devices**, or through a TURN relay when a direct path is impossible. The API never receives call media.

```
 Ana's device ──WebSocket── API ──WebSocket── Ben's device        signalling: offer, answer, ICE candidates
      │                                              │
      └──────── DTLS-SRTP media (direct) ────────────┘
      └──── or via TURN relay (coturn / Twilio / Cloudflare) ───┘
```

## How a call works
1. Ana's app opens the microphone (and camera), then sends `call.start` on its WebSocket. The API checks the same rules as direct messages (no blocks either way, the other account is live, Ben's "who can message me" setting), records the call and rings every device Ben has connected.
2. Ben answers on one device (`call.accept`). That connection is bound to the call, and his other devices stop ringing.
3. Ana (the caller always makes the offers) sends an SDP offer. Ben answers. Both trickle ICE candidates. All of this goes through `call.signal`, which the API relays only to the one connection taking part on the other side.
4. When media flows, a device sends `call.connected` and the call clock starts.
5. Either side hangs up. The API records the outcome and writes a notice into the chat ("Missed video call", "Voice call · 2:31").

The state machine is `ringing → accepted → connected → ended`. Every transition is a single conditional `UPDATE`, so racing actions (two devices answering, a hang-up crossing a timeout) have exactly one winner. Each person has at most one live call, enforced by the `call_lines` primary key. Calling someone already on a call ends at once as `busy`.

### Endings
| Reason | When |
| --- | --- |
| `completed` | Hung up after media connected |
| `declined` | The callee declined, or hung up while it rang |
| `cancelled` | The caller hung up while it rang, or either side hung up after answering but before media connected |
| `missed` | Nobody answered within `CALL_RING_SECONDS` (45 s) |
| `busy` | The callee was on another call |
| `failed` | Answered, but media did not connect within `CALL_CONNECT_SECONDS` (30 s), or a device gave up after ICE restarts |
| `connection_lost` | A device's WebSocket dropped and it did not come back within `CALL_RECONNECT_GRACE_SECONDS` (20 s) |

Missed, cancelled and busy calls that the callee never picked up become a push notification ("Missed video call"), through the same queue as chat messages ([`push.md`](push.md)).

### Recovering from network problems
- **Signalling drops** (the WebSocket closes): the call is kept. The device reconnects, sends `call.resume` on the new socket, and the caller restarts ICE. If it doesn't return within the grace period, the call ends as `connection_lost`.
- **Media path breaks** (Wi-Fi to mobile data, NAT rebinding): the app shows "Reconnecting…" and the caller does an ICE restart. If media isn't back within 20 seconds, the device hangs up with `failed`.
- **Poor network**: the apps read round-trip time and packet loss from the peer connection every 2 seconds, show "Poor connection", and cap outgoing video at 400 kbps (poor) or 150 kbps (very poor), restoring 1.5 Mbps when it recovers. Audio is never capped.

### Permissions
The app asks for the microphone (and camera for video) when a call starts or is answered, never earlier. If access is blocked, an outgoing call is not placed and the person is told how to fix it. An incoming call keeps ringing with the explanation, so they can allow access and answer, or decline.

## TURN: choosing and setting up a provider
Without TURN, calls fail for roughly 10–20% of people (strict NATs, many mobile and corporate networks). The API hands each user short-lived TURN credentials at `GET /v1/calls/ice-servers`, from whichever provider is configured. Nothing else changes between providers.

| `TURN_PROVIDER` | What you need | Notes |
| --- | --- | --- |
| `none` | Nothing | STUN only, free. Fine for development and a small beta (see below) |
| `coturn` | Your own coturn server(s) | Cheapest at scale. You run and monitor it |
| `twilio` | Twilio account | Pay per GB relayed, global anycast |
| `cloudflare` | Cloudflare account with Realtime TURN | Pay per GB relayed, global anycast |

Common settings: `STUN_URLS` (comma-separated, e.g. `stun:stun.cloudflare.com:3478`), `TURN_CREDENTIAL_TTL_SECONDS` (default 4 hours; longer than your longest expected call), and `ICE_TRANSPORT_POLICY`. Setting it to `relay` sends every call through TURN, which hides each person's IP address from the other, at the cost of relay bandwidth. The API refuses to start with `relay` and no TURN provider.

### STUN only (no TURN, free)
Managed TURN is paid, so the beta runs without a relay:
```
TURN_PROVIDER=none
STUN_URLS=stun:stun.cloudflare.com:3478
ICE_TRANSPORT_POLICY=all
```
Cloudflare's public STUN server needs no account. Most calls connect directly. Calls between two people behind strict NATs (some mobile carriers, corporate and hotel Wi-Fi) can't, and end as `failed` after `CALL_CONNECT_SECONDS`. When that happens on a device that had no relay, the apps say "your networks couldn't connect directly" and suggest trying Wi-Fi or another network, instead of a generic error. In staging and production the API refuses to start with `TURN_PROVIDER=none` and an empty `STUN_URLS`, because then calls would connect only between devices on the same network.

If too many beta calls end as `failed` (count them with `SELECT count(*) FILTER (WHERE end_reason = 'failed') * 100.0 / count(*) FROM calls WHERE answered_at IS NOT NULL`), add a relay. Self-hosted coturn (below) costs only a small server; switching is a config change and needs no app update.

### coturn (self-hosted)
1. Install coturn on a server with a public IP (`apt install coturn`), open UDP/TCP 3478, TCP 5349 (TLS), and the relay port range (e.g. UDP 49152–65535).
2. In `/etc/turnserver.conf`:
   ```
   use-auth-secret
   static-auth-secret=<long random secret>
   realm=turn.example.com
   cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
   pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
   no-cli
   fingerprint
   # Never relay into your own private network:
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   ```
3. API environment:
   ```
   TURN_PROVIDER=coturn
   TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
   TURN_SHARED_SECRET=<the same secret>
   ```
   Credentials follow coturn's TURN REST API scheme: username `<expiry>:<userId>`, password `base64(HMAC-SHA1(secret, username))`. No call to coturn is made.

### Twilio
1. In the Twilio console, create an **API key** (Account → API keys & tokens). Note the key SID (`SK…`) and secret, and your account SID (`AC…`).
2. API environment:
   ```
   TURN_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_API_KEY_SID=SK...
   TWILIO_API_KEY_SECRET=...
   ```
   Each request to `/v1/calls/ice-servers` creates a Network Traversal token (`POST /2010-04-01/Accounts/{sid}/Tokens.json`).

### Cloudflare Realtime TURN
1. In the Cloudflare dashboard, go to Realtime → TURN Server and create a TURN key. Note the key id and API token.
2. API environment:
   ```
   TURN_PROVIDER=cloudflare
   CLOUDFLARE_TURN_KEY_ID=...
   CLOUDFLARE_TURN_API_TOKEN=...
   ```
   Each request calls `POST /v1/turn/keys/{id}/credentials/generate-ice-servers`. Port 53 URLs are dropped, because browsers block them (Cloudflare's own advice).

If a provider request fails, the API logs a warning and returns STUN only with `relay: false`, so calls that can connect directly still work.

## Testing
- **API** (`apps/api/test/calls.e2e.spec.ts`): real WebSocket clients as devices. Ringing on every device and binding to the one that answers, signalling reaching only that device, every ending (completed, declined, cancelled, missed, busy, failed, connection lost), resume after a dropped socket, two devices answering at once, two people calling each other at once, blocks, privacy settings, group chats refused, history paging, export, the missed-call push, and the TURN providers (coturn HMAC, plus Twilio and Cloudflare against local stand-ins).
- **Web** (`apps/web/e2e/run.mjs › callsFlow`): two Chromium browsers with fake camera and microphone, `ICE_TRANSPORT_POLICY=relay` and a **real coturn** using the API's credentials. Checks video playing both ways through the relay, mute and camera, recovery after the signalling socket drops mid-call, hang up, decline, no answer, blocked microphone and camera, and a call failing cleanly when the relay goes down. CI installs coturn from Ubuntu.
- **Flutter** (`apps/mobile/test/calls_test.dart`): the call controller and screens with the socket and the media engine faked: outgoing and incoming calls, offer/answer/candidates, controls, permission denial, answered elsewhere, ICE restart then failure, resume after a socket drop, quality handling and history.

## Not done yet
- **Phones haven't been tested on real devices.** The Flutter media engine (`flutter_webrtc`) is type-checked and its controller is tested with a fake, but no call has been placed from an Android or iOS device in this environment.
- **Ringing when the app is closed** needs VoIP push: PushKit and CallKit on iOS, a high-priority FCM message and a full-screen notification on Android. Both need the Apple and Firebase accounts from [`push.md`](push.md). Today an incoming call rings only while the app (or the web chat page) is open; otherwise the person gets a missed-call notification.
- **On the web, calls ring only on the chat page** (`/chats`), where the realtime connection lives.
- **Group calls** need a media server (SFU) such as LiveKit or mediasoup. The API refuses calls in group chats with `group_calls_unsupported`.
- **Speaker selection** exists on phones only; browsers play through the system's default output.
- **Call quality metrics** are shown to the person but not reported to the server for monitoring (Stage 10).
- Calls are encrypted in transit (DTLS-SRTP, mandatory in WebRTC) between the two devices, and a TURN relay sees only encrypted packets. This is **not** the same as verified end-to-end encryption: nobody compares keys, so a malicious signalling server could in principle sit in the middle. Insertable-streams / SFrame encryption with verified keys would close that gap and is not built.
