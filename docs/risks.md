# Major risks

Ranked roughly by how much harm each could do and how hard it would be to undo.

| # | Risk | Why it matters | Mitigation / status |
| --- | --- | --- | --- |
| 1 | **Scope.** The brief covers about ten products: messaging, calls, social, business, payments, mini-apps, admin and more. | Trying to do all of it at once leaves every part half-built. | Staged plan with exit criteria (`plan.md`). Each stage has to work end to end before the next starts. |
| 2 | **Payments and wallet regulation** (e-money licensing, safeguarding, AML/KYC, PSD2/SCA, state money-transmitter laws) | Holding funds or offering P2P without a licence is illegal in most markets. | Licensed providers only, and no stored value or P2P until a legal review (ADR 0005). **Needs a lawyer.** |
| 3 | **E2EE correctness and licensing** | A broken implementation is worse than none, because users trust it. libsignal is AGPL-3.0. | Use libsignal only and never claim E2EE before it ships (ADR 0004). **Licence needs legal review.** |
| 4 | **Privacy law** (GDPR, UK GDPR, CCPA/CPRA, LGPD, PIPL, DPDP and others) | Fines, and app-store removal. | Data inventory and deletion are built (`security-privacy.md`). A per-region legal assessment is **still needed**. We never call the product "globally compliant". |
| 5 | **Child safety and illegal content** (DSA, UK Online Safety Act, CSAM reporting duties) | Legal duties start once user-generated content and media launch. Media sharing in chats is now built (Stage 3). | User reports are built, and uploads are type-checked. **Not built:** known-CSAM hash matching, malware scanning, an admin moderation queue, NCMEC/IWF reporting processes. Media must not be opened to the public until these exist. |
| 6 | **Account takeover and abuse** (credential stuffing, spam sign-ups, SIM swap) | It is a messaging app, so stolen accounts are valuable. | Argon2id, rate limits per IP and per account, TOTP MFA, refresh-reuse detection, device list. **Still to do:** breached-password check, CAPTCHA or device attestation on sign-up, SMS fraud controls. |
| 7 | **Real-time scale** (WebSocket fan-out, presence, delivery ordering) | Hard to change after launch. | Built: per-conversation counters taken under a row lock, a change feed for recovery, and Redis pub/sub fan-out (`realtime.md`). Measured in Stage 9 on one instance: 256-member groups deliver to everyone in 26 ms p95, and 650 to 710 messages a second across 100 busy chats, limited by the database pool (`hardening.md`). Still to measure: several instances sharing Redis, and long soak runs. |
| 8 | **Calls infrastructure** | TURN and SFU bandwidth costs, NAT traversal, and quality. | Use a managed TURN service or coturn, and a proven SFU (LiveKit or mediasoup) for groups. Cost model before Stage 6. |
| 9 | **App store rules** (IAP for digital goods, rules on mini-app code, review of UGC apps) | Rejection blocks the launch. | Built into the payments and mini-app ADRs. Moderation and blocking are present from day one. |
| 10 | **Mini-app sandbox escape or data overreach** | Third-party code would sit beside private data. | Curated catalogue first, and a runtime only after a security review (ADR 0006). |
| 11 | **Brand and trademark** | "Nexa" is a placeholder and may clash with existing marks. | Trademark search before launch. Tokens make a rebrand cheap. |
| 12 | **Trusted proxy configuration** | If `TRUST_PROXY` is set wrong, clients can forge `X-Forwarded-For` and dodge per-IP limits. | Done in Stage 9: `TRUST_PROXY` is an allow-list of proxy addresses and `true` is refused in staging and production; the web server takes the address its own proxy added (`WEB_PROXY_HOPS`). Per-account limits apply as well. Set both for each deployment (`hardening.md`). |

## Known gaps in what is built today
- There is no breached or common password check. Only length is enforced (10 to 256).
- Phone sign-up and verification are not implemented, because they need an SMS provider (Twilio, Vonage, MessageBird and similar) and fraud controls.
- Avatars are a column only. Object storage now exists, so this is a small follow-up.
- Chats are not end-to-end encrypted (ADR 0004, blocked on the libsignal licence review).
- No malware or CSAM scanning of uploads, and no thumbnails or video transcoding. The file-signature check is not a scan.
- Uploads that are started but never completed are not cleaned up yet. Use a bucket lifecycle rule until the job exists.
- Unsent messages are kept in memory on web and mobile, so they are lost if the app is closed before reconnecting.
- Contacts discovery is not implemented. It will be opt-in only, with hashed identifiers and rate limits, and we know hashing alone does not anonymise phone numbers.
- Account deletion scrubs personal data immediately. A scheduled purge of tombstone rows and backups (backup retention) is not built yet.
- Simultaneous refreshes from two browser tabs can sign the user out (see ADR 0002).
- Push notifications show message text through Apple's and Google's push services by default, because chats are not end-to-end encrypted yet. People can choose "sender only" or "nothing". Revisit the default when E2EE ships.
- iPhone and Android do not receive notifications yet: the server side is built, but it needs APNs and FCM credentials and the apps still have to register for push.
