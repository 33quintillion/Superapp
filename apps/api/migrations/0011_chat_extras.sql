-- Chat extras, as in WhatsApp and WeChat: polls, starred messages, disappearing messages,
-- view-once photos and videos, location (one-off or live) and contact cards.

ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check
  CHECK (kind IN ('text', 'image', 'video', 'audio', 'voice', 'file', 'system', 'poll', 'location', 'contact'));

ALTER TABLE messages
  -- Photos and videos that each other member can open once.
  ADD COLUMN view_once boolean NOT NULL DEFAULT false,
  -- Set when the chat had disappearing messages on at the time of sending.
  ADD COLUMN expires_at timestamptz,
  -- Location ({lat, lng, label, liveUntil}) and contact cards ({userId}).
  ADD COLUMN attachment jsonb;

ALTER TABLE messages ADD CONSTRAINT messages_view_once CHECK (NOT view_once OR kind IN ('image', 'video'));
ALTER TABLE messages ADD CONSTRAINT messages_attachment
  CHECK ((kind IN ('location', 'contact')) = (attachment IS NOT NULL) OR deleted_at IS NOT NULL);
-- Deleting clears everything a message carried, as before.
ALTER TABLE messages ADD CONSTRAINT messages_deleted_attachment CHECK (deleted_at IS NULL OR attachment IS NULL);
CREATE INDEX messages_expiring ON messages (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Off (NULL), 24 hours, 7 days or 90 days, as WhatsApp offers.
ALTER TABLE conversations ADD COLUMN disappear_seconds integer
  CHECK (disappear_seconds IS NULL OR disappear_seconds IN (86400, 604800, 7776000));

-- The question is the message body.
CREATE TABLE message_polls (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  options    text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 12),
  multiple   boolean NOT NULL DEFAULT false
);

CREATE TABLE poll_votes (
  message_id uuid NOT NULL REFERENCES message_polls(message_id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option     smallint NOT NULL CHECK (option BETWEEN 0 AND 11),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option)
);

-- Starred messages are private to the person who starred them.
CREATE TABLE message_stars (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX message_stars_recent ON message_stars (user_id, created_at DESC);
CREATE INDEX message_stars_message ON message_stars (message_id);

-- Who has opened a view-once message (each member once).
CREATE TABLE view_once_opens (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
