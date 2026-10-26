-- Stage 1/2: identity, sessions, one-time tokens, privacy, safety, audit.
-- Emails and usernames are stored normalised (lower-case) by the application.

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text UNIQUE,
  email_verified_at timestamptz,
  phone_e164       text UNIQUE,
  phone_verified_at timestamptz,
  username         text UNIQUE,
  password_hash    text,
  display_name     text NOT NULL DEFAULT '',
  bio              text NOT NULL DEFAULT '',
  status_text      text NOT NULL DEFAULT '',
  avatar_object_key text,
  locale           text NOT NULL DEFAULT 'en',
  mfa_totp_secret_enc text,
  mfa_pending_secret_enc text,
  mfa_enabled_at   timestamptz,
  mfa_last_counter bigint,
  state            text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deactivated', 'deleted')),
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT username_format CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,30}$'),
  CONSTRAINT phone_format CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT active_has_login CHECK (state = 'deleted' OR (email IS NOT NULL OR phone_e164 IS NOT NULL))
);

CREATE TABLE privacy_settings (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discoverable_by_email   boolean NOT NULL DEFAULT false,
  discoverable_by_phone   boolean NOT NULL DEFAULT false,
  discoverable_by_username boolean NOT NULL DEFAULT true,
  who_can_message         text NOT NULL DEFAULT 'everyone' CHECK (who_can_message IN ('everyone', 'contacts', 'nobody')),
  show_online_status      boolean NOT NULL DEFAULT true,
  show_read_receipts      boolean NOT NULL DEFAULT true,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- One row per logged-in device. Refresh tokens rotate within a session; the
-- session is the unit the user sees and revokes.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name        text NOT NULL DEFAULT 'Unknown device',
  user_agent         text,
  ip                 inet,
  refresh_token_hash text NOT NULL UNIQUE,
  refresh_generation integer NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  revoked_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- Hashes of refresh tokens that have been rotated out. Presenting one again means
-- the token was stolen or replayed, and the whole session is revoked.
CREATE TABLE retired_refresh_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  retired_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE one_time_tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'mfa_challenge')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX one_time_tokens_user ON one_time_tokens (user_id, purpose);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked ON blocks (blocked_id);

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'message', 'post', 'business', 'mini_app')),
  subject_id   text NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'violence', 'sexual_content', 'child_safety', 'fraud', 'impersonation', 'other')),
  details      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'actioned', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_open ON reports (created_at) WHERE status = 'open';

-- Append-only record of security-relevant actions. Never stores secrets or tokens.
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id   uuid,
  action     text NOT NULL,
  target_type text,
  target_id  text,
  ip         inet,
  metadata   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor ON audit_log (actor_id, created_at DESC);
