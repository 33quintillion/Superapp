# Security and privacy

This describes the system **as built today** (Stages 1 to 3, Stage 4 push notifications, and Stage 5 social features). Update it with every stage. Nothing here amounts to a claim of legal compliance in any jurisdiction; that needs a regional legal assessment.

## Data we hold

| Data | Where | Protection | Retention |
| --- | --- | --- | --- |
| Email, username, display name, bio, status, locale | `users` | Encrypted in transit (TLS, set up at deployment). At rest relies on disk or volume encryption from the database host. | Until deletion, then scrubbed immediately |
| Password | `users.password_hash` | Argon2id hash only | Until deletion or change |
| TOTP seed | `users.mfa_totp_secret_enc` | AES-256-GCM with `DATA_ENCRYPTION_KEY`, bound to the user id | Until MFA is disabled or the account deleted |
| Sessions (device name, user agent, IP, timestamps) | `sessions` | Refresh tokens stored as SHA-256 hashes only | Revoked rows kept for the security history; deleted with the account. A retention job is still to build. |
| One-time tokens | `one_time_tokens` | SHA-256 hashes; 5 min (MFA), 30 min (reset) or 48 h (verify) | Deleted with the account. A cleanup job is still to build. |
| Blocks | `blocks` | | Deleted with either account |
| Reports | `reports` | | Kept for safety review; the reporter is detached on deletion |
| Audit log (action, actor id, IP, time) | `audit_log` | Append-only from the app; holds no secrets | IP removed on deletion; uuid-only records kept |
| Conversations and membership (who talks to whom, when, read and delivered positions, mute and archive) | `conversations`, `conversation_members` | TLS in transit. **Readable by the server.** | Kept while either person has the account. The deleted person shows as "Deleted account" |
| Message text, replies, mentions, reactions, pins, edit and delete times | `messages`, `message_reactions`, `message_hides` | TLS in transit. **Readable by the server; not end-to-end encrypted.** | "Delete for everyone" clears the text immediately and keeps a tombstone (id, sender, times). Account deletion does the same for every message the person sent |
| Photos, videos, voice notes and files | Object storage (`media/<owner>/<random id>`), metadata in `media` | Private bucket. Short-lived presigned URLs (15 min upload, 5 min download), issued after an access check. **Readable by the server and the storage provider.** | Deleted from storage when the last message using the file is deleted, or when the uploader's account is deleted. Uploads never completed still need a cleanup job |
| Presence (online, last seen) and typing | Redis | Not persisted to Postgres. Typing is never stored | Presence expires about 75 s after the last heartbeat; last seen is kept 90 days |
| One-time WebSocket tickets | Redis (SHA-256 of the ticket) | Single use | 60 s |
| Group chat settings and roles; join and leave times as notices in the chat | `conversations`, `conversation_members`, `messages` (kind `system`) | Readable by the server | Kept with the group. A deleted account leaves its groups; ownership passes on |
| Follows and follow requests | `follows` | | Deleted with either account, and both ways on a block |
| Posts, likes, comments and shares | `posts`, `post_media`, `post_likes`, `post_comments` | TLS in transit. **Readable by the server.** Visibility decided per request by SQL functions | Until the author deletes them, or account deletion (which deletes posts, comments and likes and their files). Moderator removals keep the post hidden with the reason, visible to its author |
| Stories and who viewed them | `stories`, `story_views` | Viewer lists are shown only to the author | 24 hours, then deleted with their files by a sweep (every 5 minutes by default) |
| Communities and membership (role, pending, banned) | `communities`, `community_members` | Private communities show only their name and description to outsiders | Until deleted by the owner; memberships go with the account |
| Push registrations (provider, device token or browser subscription URL and keys, last delivery time) | `push_devices` | Tied to one session. Tokens are never returned by the API or included in exports | Deleted when the session ends (within a minute), when the provider reports the token dead, on deactivation, and with the account |
| Notification settings (on/off, preview level, quiet hours and time zone) | `notification_settings` | | Deleted with the account |
| Notification queue (recipient, device, message id, state, attempts, error) | `push_jobs` | Holds message ids only, never text; the text is read at send time | Finished jobs deleted after 7 days; deleted with the device, message or account |

**End-to-end encryption:** none. Stage 3 messaging is **not** end-to-end encrypted. The server and anyone with database or bucket access can read messages and files. The apps say this, and nothing may describe chats as end-to-end encrypted until ADR 0004 is implemented and verified. TLS and server-side encryption of TOTP seeds are *not* E2EE.

**What the server can see today:** everything listed above, including message content, files, who talks to whom and when, IP addresses, and read and online state (subject to each person's privacy settings for what *other users* see; the server itself always sees it). Administrators have no hidden reading tool. The admin app (Stage 7) will work from user reports, and this table will be updated when it does.

**External processors today:** the SMTP email provider receives recipient addresses and the text of verification and reset emails. The object-storage provider (whatever S3-compatible service is configured) stores uploaded files. When push is configured, Apple (APNs), Google (FCM) and browser vendors' push services receive device tokens and notification payloads: by default the sender's name and the message text, or less if the person chooses a smaller preview. Web Push payloads are encrypted for the browser, so the browser vendor relays only ciphertext; APNs and FCM payloads are protected only in transit. No analytics, crash reporting or advertising SDKs are included.

## Controls in place
- Argon2id passwords, with timing equalised for unknown accounts.
- Short-lived access tokens checked against a live session on every request, and rotating refresh tokens with reuse detection.
- Rate limits per IP and per account on sign-up, login, two-step, password reset, verification resend and reports.
- Optional TOTP with replay protection.
- Generic credential errors, and password reset that does not reveal which accounts exist.
- Profile lookups return 404 (not 403) when hidden by privacy or a block, so a hidden account cannot be confirmed to exist.
- Web tokens only in `httpOnly` cookies. The API URL stays server-side, and nothing secret is sent to the browser.
- Mobile refresh tokens in the platform keystore. No secrets are compiled into the app.
- Secrets come only from the environment. Weak or missing secrets stop the app from starting, and `.env*` files are git-ignored.
- Logs redact authorization headers, cookies, passwords and tokens.
- Account export, deactivation and deletion are self-service and need the password. The export includes messages the person sent and a list of their uploads.
- Messaging permissions: only members can read or write a conversation, and outsiders get 404. Blocks stop messages, reactions, pins and typing in both directions. "Who can message me" (`contacts` or `nobody`) refuses chats from strangers until the person replies.
- Read receipts and online status are shared only when both people allow it.
- Social visibility: posts, comments, likes, stories, community posts and their photos all pass through the same SQL rules (`can_view_post`, `can_view_story`, `can_view_community`, `blocked_either_way`), so a list, a single read and a file download cannot disagree. Audiences (everyone, followers, only me), private accounts and private communities are enforced on the server, and anything hidden is a 404. Sharing a post never widens who can see the original. Blocks remove follows in both directions and hide all content and reactions between the two people.
- Groups: new members cannot read history from before they joined. "Who can add me to groups" and blocks are checked when anyone is added. Admin rights follow a strict hierarchy.
- Moderation: community moderators can remove posts and comments (with a reason recorded in the audit log), approve, ban and remove members ranked below them. Reports can be filed on people, messages, posts, comments, stories and communities. The review queue for reports is still to build (Stage 7).
- Spam: per-person rate limits on posting, commenting, liking, following, stories, joining and creating communities and groups.
- Uploads: the type is chosen from an allow-list (no SVG, HTML or executables), with size limits per kind. The signed upload URL fixes the content type and length, and the stored file's signature is checked against its declared type before it can be sent. Object keys never contain user input.
- WebSockets authenticate with single-use 60-second tickets, never access tokens in URLs. Browser origins are checked, and sessions are re-checked while the socket is open. There are frame-size and frame-rate limits.
- The web chat reaches the API only through a server-side proxy limited to the messaging, notification, group and social endpoints it uses, and the proxy refuses cross-site writes.
- Push: registrations are bound to a session and stop the moment it ends. Web Push subscription URLs are accepted only on known browser push services, so the API cannot be aimed at internal hosts. Notifications are re-checked at send time against blocks, mutes, deletions and read state. Push credentials come only from the environment, are validated at startup, and test-only endpoint overrides are refused in staging and production.

## Before production (not done yet)
- Secret manager (AWS Secrets Manager, GCP Secret Manager or Vault) and a key-rotation procedure for `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY`.
- Database encryption at rest, encrypted backups, restore drills.
- WAF and bot protection on sign-up; breached-password check.
- Privacy policy, terms, cookie notice, records of processing, DPIA, and data processing agreements with providers (**legal**).
- **Before media sharing is opened to the public:** known-CSAM hash matching (for example PhotoDNA, or an equivalent from a child-safety partner), malware scanning of uploads, a moderation queue for reported messages, posts, stories and media, and NCMEC/IWF reporting procedures. Media sharing works today but **must not launch publicly without these** (**legal and trust & safety**).
- Age gating and a child-safety programme (**legal and trust & safety**).
- Bucket-level encryption at rest and lifecycle rules (expire incomplete uploads) on the production bucket.
- Penetration test (Stage 9).
