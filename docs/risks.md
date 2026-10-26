# Major risks

Ranked roughly by how much harm each could do and how hard it would be to undo.

| # | Risk | Why it matters | Mitigation / status |
| --- | --- | --- | --- |
| 1 | **Scope.** The brief covers about ten products: messaging, calls, social, business, payments, mini-apps, admin and more. | Trying to do all of it at once leaves every part half-built. | Staged plan with exit criteria (`plan.md`). Each stage has to work end to end before the next starts. |
| 2 | **Payments and wallet regulation** (e-money licensing, safeguarding, AML/KYC, PSD2/SCA, state money-transmitter laws) | Holding funds or offering P2P without a licence is illegal in most markets. | Licensed providers only, and no stored value or P2P until a legal review (ADR 0005). **Needs a lawyer.** |
| 3 | **E2EE correctness and licensing** | A broken implementation is worse than none, because users trust it. libsignal is AGPL-3.0. | Use libsignal only and never claim E2EE before it ships (ADR 0004). **Licence needs legal review.** |
| 4 | **Privacy law** (GDPR, UK GDPR, CCPA/CPRA, LGPD, PIPL, DPDP and others) | Fines, and app-store removal. | Data inventory and deletion are built (`security-privacy.md`). A per-region legal assessment is **still needed**. We never call the product "globally compliant". |
| 5 | **Child safety and illegal content** (DSA, UK Online Safety Act, CSAM reporting duties) | Legal duties start once user-generated content and media launch (Stages 3 and 5). | User reports are built. Media hash-matching, an admin moderation queue, and NCMEC/IWF reporting processes are needed before media launches. |
| 6 | **Account takeover and abuse** (credential stuffing, spam sign-ups, SIM swap) | It is a messaging app, so stolen accounts are valuable. | Argon2id, rate limits per IP and per account, TOTP MFA, refresh-reuse detection, device list. **Still to do:** breached-password check, CAPTCHA or device attestation on sign-up, SMS fraud controls. |
| 7 | **Real-time scale** (WebSocket fan-out, presence, delivery ordering) | Hard to change after launch. | Design for each device's own queue and server-assigned per-conversation sequence numbers in Stage 3. Load tests in Stage 9. |
| 8 | **Calls infrastructure** | TURN and SFU bandwidth costs, NAT traversal, and quality. | Use a managed TURN service or coturn, and a proven SFU (LiveKit or mediasoup) for groups. Cost model before Stage 6. |
| 9 | **App store rules** (IAP for digital goods, rules on mini-app code, review of UGC apps) | Rejection blocks the launch. | Built into the payments and mini-app ADRs. Moderation and blocking are present from day one. |
| 10 | **Mini-app sandbox escape or data overreach** | Third-party code would sit beside private data. | Curated catalogue first, and a runtime only after a security review (ADR 0006). |
| 11 | **Brand and trademark** | "Nexa" is a placeholder and may clash with existing marks. | Trademark search before launch. Tokens make a rebrand cheap. |
| 12 | **Trusted proxy configuration** | If `TRUST_PROXY` is set wrong, clients can forge `X-Forwarded-For` and dodge per-IP limits. | Per-account limits apply as well. Document the setup for each deployment, and switch from a boolean to an allow-list of proxy IPs before staging. |

## Known gaps in what is built today
- There is no breached or common password check. Only length is enforced (10 to 256).
- Phone sign-up and verification are not implemented, because they need an SMS provider (Twilio, Vonage, MessageBird and similar) and fraud controls.
- Avatars are a column only. Upload needs object storage and media scanning (Stage 3).
- Contacts discovery is not implemented. It will be opt-in only, with hashed identifiers and rate limits, and we know hashing alone does not anonymise phone numbers.
- Account deletion scrubs personal data immediately. A scheduled purge of tombstone rows and backups (backup retention) is not built yet.
- Simultaneous refreshes from two browser tabs can sign the user out (see ADR 0002).
