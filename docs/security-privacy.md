# Security and privacy

This describes the system **as built today** (Stages 1 and 2). Update it with every stage. Nothing here amounts to a claim of legal compliance in any jurisdiction; that needs a regional legal assessment.

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

**End-to-end encryption:** none yet. Nothing in the system today is end-to-end encrypted, and the product must not say otherwise until Stage 3 ships and is verified (ADR 0004). Server-side encryption of TOTP seeds is *not* E2EE.

**External processors today:** the SMTP email provider receives recipient addresses and the text of verification and reset emails. No analytics, crash reporting or advertising SDKs are included.

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
- Account export, deactivation and deletion are self-service and need the password.

## Before production (not done yet)
- Secret manager (AWS Secrets Manager, GCP Secret Manager or Vault) and a key-rotation procedure for `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY`.
- Database encryption at rest, encrypted backups, restore drills.
- WAF and bot protection on sign-up; breached-password check.
- Privacy policy, terms, cookie notice, records of processing, DPIA, and data processing agreements with providers (**legal**).
- Age gating and a child-safety programme before user-generated media launches (**legal and trust & safety**).
- Penetration test (Stage 9).
