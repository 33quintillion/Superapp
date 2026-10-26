-- Stage 3: conversations, messages, receipts, reactions, media.
-- Message content is stored readable by the server. It is NOT end-to-end encrypted
-- (see docs/adr/0004-end-to-end-encryption.md for why and what changes when it is).

CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('direct', 'group')),
  -- Direct chats: both user ids, sorted and joined, so a pair can only ever have one.
  direct_key      text UNIQUE,
  title           text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Per-conversation counter. Every change (new message, edit, delete, reaction, pin,
  -- hide) takes the next value while holding the row lock, so values commit in order
  -- and clients can detect gaps and resync from the last value they saw.
  last_seq        bigint NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);

CREATE TABLE conversation_members (
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at          timestamptz NOT NULL DEFAULT now(),
  last_delivered_seq bigint NOT NULL DEFAULT 0,
  last_read_seq      bigint NOT NULL DEFAULT 0,
  muted_until        timestamptz,
  archived_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  CHECK (last_read_seq <= last_delivered_seq)
);
CREATE INDEX conversation_members_user ON conversation_members (user_id);

CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'voice', 'file')),
  content_type text NOT NULL,
  byte_size    bigint NOT NULL CHECK (byte_size > 0),
  file_name    text NOT NULL DEFAULT '',
  object_key   text NOT NULL UNIQUE,
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms > 0),
  width        integer CHECK (width IS NULL OR width > 0),
  height       integer CHECK (height IS NULL OR height > 0),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'rejected', 'deleted')),
  -- No malware scanner is wired up yet; see docs/feature-checklist.md.
  scan_status  text NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned', 'clean', 'infected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX media_owner ON media (owner_id, created_at DESC);
CREATE INDEX media_pending ON media (created_at) WHERE state = 'pending';

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  change_seq      bigint NOT NULL,
  sender_id       uuid NOT NULL REFERENCES users(id),
  -- Chosen by the sending device. Retrying with the same id returns the original message.
  client_id       text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind            text NOT NULL CHECK (kind IN ('text', 'image', 'video', 'audio', 'voice', 'file')),
  body            text NOT NULL DEFAULT '',
  media_id        uuid REFERENCES media(id) ON DELETE SET NULL,
  reply_to_id     uuid REFERENCES messages(id) ON DELETE SET NULL,
  forwarded       boolean NOT NULL DEFAULT false,
  mentions        uuid[] NOT NULL DEFAULT '{}',
  edited_at       timestamptz,
  deleted_at      timestamptz,
  pinned_at       timestamptz,
  pinned_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  UNIQUE (conversation_id, sender_id, client_id),
  CHECK (change_seq >= seq),
  CHECK (deleted_at IS NULL OR (body = '' AND media_id IS NULL))
);
CREATE INDEX messages_changes ON messages (conversation_id, change_seq);
CREATE INDEX messages_media ON messages (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX messages_pinned ON messages (conversation_id) WHERE pinned_at IS NOT NULL;
CREATE INDEX messages_sender ON messages (sender_id, created_at);
-- 'simple' does no stemming, so search behaves the same in every language.
CREATE INDEX messages_search ON messages USING gin (to_tsvector('simple', body)) WHERE deleted_at IS NULL;

CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- "Delete for me": the message stays for everyone else.
CREATE TABLE message_hides (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_hides_user ON message_hides (user_id);
