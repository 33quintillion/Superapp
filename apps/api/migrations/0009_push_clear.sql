-- Clearing notifications on a person's other devices once they read the chat somewhere.
-- A "clear" job tells one device to remove its notifications for a conversation up to a
-- given message. It carries no message text.

ALTER TABLE push_jobs DROP CONSTRAINT push_jobs_kind_check;
ALTER TABLE push_jobs ADD CONSTRAINT push_jobs_kind_check CHECK (kind IN ('message', 'test', 'clear'));
ALTER TABLE push_jobs ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE;
-- Clear notifications for messages up to and including this one.
ALTER TABLE push_jobs ADD COLUMN clear_seq bigint;
ALTER TABLE push_jobs ADD CONSTRAINT push_jobs_clear_check
  CHECK ((kind = 'clear') = (conversation_id IS NOT NULL AND clear_seq IS NOT NULL));
-- At most one waiting clear per device and chat: reading further just moves it forward.
CREATE UNIQUE INDEX push_jobs_pending_clear ON push_jobs (device_id, conversation_id) WHERE kind = 'clear' AND state = 'pending';
