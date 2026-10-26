# Local development

## With Docker (recommended)
See the quick start in the root `README.md`. `infra/docker-compose.yml` starts Postgres 16, Redis 7 and Mailpit, and creates the `superapp_test` and `superapp_e2e` databases.

## Without Docker
Install Postgres 16 and Redis 7 natively, then:

```bash
sudo -u postgres psql -c "CREATE ROLE superapp LOGIN PASSWORD 'superapp_dev' CREATEDB;"
for db in superapp_dev superapp_test superapp_e2e; do sudo -u postgres createdb -O superapp $db; done
redis-server --daemonize yes
```

For media, run MinIO as a binary (`minio server ~/minio-data`), or any S3-compatible service, and set the `S3_*` variables. The tests expect one on `http://localhost:9000` with the `minioadmin` credentials; override with `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY_ID` and `TEST_S3_SECRET_ACCESS_KEY`. If MinIO isn't available, moto's S3 server works for local runs (`pip install 'moto[server]' && moto_server -p 9000`), but CI uses real MinIO because moto doesn't check signatures.

For email, run Mailpit as a binary (https://mailpit.axllent.org), or point `SMTP_URL` at any SMTP server you control.

## Environment
Copy `.env.example` and generate the two secrets:

```bash
echo "JWT_ACCESS_SECRET=$(openssl rand -hex 32)"
echo "DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

Tests use their own fixed test-only secrets and the `superapp_test` database. The schema is dropped and rebuilt from the migrations on every run, so **never point `TEST_DATABASE_URL` at a database you care about**.

## Mobile
- Android emulator: `--dart-define=API_BASE_URL=http://10.0.2.2:3000`
- iOS simulator: `--dart-define=API_BASE_URL=http://localhost:3000`
- A physical device needs your machine's LAN IP, and Android needs cleartext HTTP allowed for local development only. Staging and production must use HTTPS.

## Design tokens
Edit `packages/design-tokens/tokens.json`, then run `pnpm tokens`. CI fails if the generated files are stale.
