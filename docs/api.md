# API reference (v1)

Base URL: `http://localhost:3000` locally. Requests and responses are JSON. Authenticated routes need `Authorization: Bearer <accessToken>`.

Errors always look like `{ "error": { "code": "…", "message": "…", "requestId": "…", "details"?: … } }`. Common codes: `validation_failed` (400), `invalid_token` (400), `unauthorized` / `invalid_credentials` (401), `not_found` (404), `email_taken` / `username_taken` (409), `rate_limited` (429, with a `Retry-After` header).

A token pair looks like `{ accessToken, refreshToken, expiresIn, sessionId }`.

## Health
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health/live` | Process is up |
| GET | `/health/ready` | `{ status, checks: { database, redis } }`, 503 if degraded |

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
