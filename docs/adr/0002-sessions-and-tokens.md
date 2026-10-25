# ADR 0002: Sessions and tokens

**Status:** accepted, 2026-10-25

## Decision
- Each login creates a **session** row: one per device, with a name, user agent, IP and last-used time. It is the unit users see and revoke.
- **Access tokens** are HS256 JWTs lasting 15 minutes, with `sub` (user) and `sid` (session) claims. On every request the guard also checks that the session is not revoked and the user is active. Revocation therefore works immediately, at the cost of one indexed query per request. A short Redis cache can be added later if needed.
- **Refresh tokens** are opaque random values (256-bit), stored only as SHA-256 hashes, and **rotated on every use**. Old hashes go into `retired_refresh_tokens`. Presenting a retired token revokes the whole session, which detects a stolen or replayed token.
- **Passwords** use Argon2id (19 MiB, t=2, p=1, the OWASP baseline). Unknown emails still go through a dummy verification so timing does not reveal which accounts exist.
- **One-time tokens** (email verification, password reset, MFA challenge) are random, stored hashed, single-use and short-lived. A reset revokes every session and every other outstanding reset link.
- **MFA** is RFC 6238 TOTP, checked against the RFC test vectors. Seeds are sealed with AES-256-GCM, with the user id bound as associated data. The last accepted time step is stored so a code cannot be reused.
- **Web** keeps both tokens in `httpOnly`, `SameSite=Lax` cookies, marked `Secure` in production. Next.js middleware refreshes once when the access cookie expires.
- **Mobile** keeps the refresh token in the Keychain or Keystore (`flutter_secure_storage`) and the access token in memory.

## Trade-offs and follow-ups
- HS256 means a single shared signing key. Move to asymmetric keys (EdDSA) with a published JWKS once other services need to verify tokens.
- If two browser tabs refresh at the same moment, one can trigger reuse detection and sign the user out. A short grace window for the previous token is a planned refinement.
- Registration reveals whether an email or username is taken (409). That is the usual trade-off for usable sign-up. Login and password reset do not reveal it.
