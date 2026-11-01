-- Profile photos. The photo is an ordinary uploaded image (media table), so it gets the
-- same type check, size limits and storage handling as chat photos. The old
-- avatar_object_key column was never used.

ALTER TABLE users DROP COLUMN avatar_object_key;
ALTER TABLE users ADD COLUMN avatar_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
CREATE INDEX users_avatar_media ON users (avatar_media_id) WHERE avatar_media_id IS NOT NULL;
