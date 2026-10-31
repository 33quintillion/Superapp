# Staging

A private test site on free plans, set up by `render.yaml` at the repository root.

| Piece | Where | Notes |
| --- | --- | --- |
| Database | Neon project `SUPERAPP`, branch `production`, database `neondb` (Singapore) | Postgres 18. Migrations run when the API starts. |
| Files (photos, voice notes) | Neon Object Storage, bucket `nexa-media` (private) | S3-compatible, path-style. `S3_MANAGE_CORS=true` sets the browser-upload rule at startup. |
| Cache | Render Key Value `nexa-cache` (free) | Rate limits, presence and fan-out only; nothing lost here is durable data. |
| API and web | Render `nexa-api` (https://nexa-api-3l54.onrender.com) and `nexa-web` (https://nexa-web-yuma.onrender.com), free, Singapore | Free services sleep when idle; the first request after that takes about a minute. |

## Values set in Render, not in the repository

- `DATABASE_URL`: Neon's **direct** connection string (connection pooling off). Migrations hold a session-level advisory lock, which a transaction-mode pooler would break.
- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`: a Neon credential with `storage:read` and `storage:write` on the `production` branch.
- `BREVO_API_KEY`: a Brevo API key (Brevo → SMTP & API → API keys). Render's free plan blocks outbound SMTP (ports 25, 465 and 587), so staging sets `MAIL_TRANSPORT=brevo` and sends through Brevo's HTTPS API. With Brevo's IP blocking on, Render's Singapore outbound ranges (`74.220.52.0/24`, `74.220.60.0/24`, under the service's Connect → Outbound) must be authorized IPs. `MAIL_FROM`: a sender address verified in Brevo.
- `SMTP_USER` and `SMTP_PASS` (SMTP login and key, pasted as shown) are for hosts that allow SMTP.
- `PUBLIC_WEB_URL` and `CORS_ORIGINS`: the web service's address. `API_INTERNAL_URL` and `API_PUBLIC_WS_URL`: the API's address (`https://` and `wss://`).

`JWT_ACCESS_SECRET` (64 hex characters) and `DATA_ENCRYPTION_KEY` (32 random bytes, base64) are set in Render. The dashboard's Generate button makes only 16 bytes, too short for the encryption key, so make them with `openssl rand -hex 32` and `openssl rand -base64 32` (a Blueprint's `generateValue` is long enough). Never change `DATA_ENCRYPTION_KEY` afterwards: it encrypts stored secrets such as two-step codes.
