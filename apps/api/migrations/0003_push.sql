-- Stage 4: push notification devices, per-person notification settings, and a durable
-- delivery queue. Delivery providers (APNs, FCM, Web Push) are configured with
-- environment variables; see docs/push.md.

-- One push registration per signed-in session. Signing out (or any revocation) stops
-- delivery at once, because every send re-checks that the session is still live, and
-- the worker deletes registrations of dead sessions shortly after.
CREATE TABLE push_devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id       uuid NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('apns', 'fcm', 'webpush')),
  -- APNs and FCM: the device token. Web Push: the subscription endpoint URL.
  token            text NOT NULL CHECK (char_length(token) BETWEEN 8 AND 2048),
  -- Web Push subscription keys (base64url), used to encrypt every payload (RFC 8291).
  webpush_p256dh   text,
  webpush_auth     text,
  apns_environment text CHECK (apns_environment IN ('sandbox', 'production')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  -- Set when the provider says the token is dead (app uninstalled, subscription expired).
  disabled_at      timestamptz,
  disabled_reason  text,
  -- A token belongs to one session at a time; registering it again moves it.
  UNIQUE (provider, token),
  CHECK ((provider = 'webpush') = (webpush_p256dh IS NOT NULL AND webpush_auth IS NOT NULL)),
  CHECK ((provider = 'apns') = (apns_environment IS NOT NULL))
);
CREATE INDEX push_devices_user ON push_devices (user_id);

-- Absent row means the defaults.
CREATE TABLE notification_settings (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL DEFAULT true,
  -- full: sender and text. sender: sender only. none: "New message" only.
  -- Message text is not end-to-end encrypted, so "full" passes it through Apple, Google
  -- or the browser vendor's push service (encrypted in transit; Web Push payloads are
  -- also encrypted end to end to the browser).
  preview      text NOT NULL DEFAULT 'full' CHECK (preview IN ('full', 'sender', 'none')),
  -- Minutes after local midnight. During quiet hours notifications arrive without sound.
  quiet_start  smallint CHECK (quiet_start BETWEEN 0 AND 1439),
  quiet_end    smallint CHECK (quiet_end BETWEEN 0 AND 1439),
  time_zone    text NOT NULL DEFAULT 'UTC',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

-- Transactional outbox: a message and its push jobs commit together, so a crash between
-- "message saved" and "push sent" cannot lose the notification. Workers on any API
-- instance claim due jobs with SKIP LOCKED and retry with backoff.
CREATE TABLE push_jobs (
  id           bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('message', 'test')),
  message_id   uuid REFERENCES messages(id) ON DELETE CASCADE,
  -- pending → sent | failed (gave up or provider refused) | dropped (no longer needed:
  -- read elsewhere, deleted, muted, signed out...). last_error says why.
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'dropped')),
  attempts     integer NOT NULL DEFAULT 0,
  run_at       timestamptz NOT NULL DEFAULT now(),
  -- A worker's claim. If the worker dies, the job becomes claimable again after this.
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (device_id, message_id),
  CHECK ((kind = 'message') = (message_id IS NOT NULL))
);
CREATE INDEX push_jobs_due ON push_jobs (run_at) WHERE state = 'pending';
CREATE INDEX push_jobs_finished ON push_jobs (finished_at) WHERE state <> 'pending';
CREATE INDEX push_jobs_message ON push_jobs (message_id) WHERE message_id IS NOT NULL;
