-- Stage 5: group chats, follows, posts (feed), stories, communities and channels.
-- Like messages, none of this is end-to-end encrypted: posts and stories are published
-- content the server must filter by audience, so it can read them.
-- Keyset cursors carry millisecond timestamps, so paged tables store milliseconds too.

-- ------------------------------------------------------------------ groups

ALTER TABLE conversations
  ADD COLUMN description text NOT NULL DEFAULT '',
  -- Who may send messages, change the title and description, and add people.
  ADD COLUMN send_policy text NOT NULL DEFAULT 'everyone' CHECK (send_policy IN ('everyone', 'admins')),
  ADD COLUMN info_policy text NOT NULL DEFAULT 'admins' CHECK (info_policy IN ('everyone', 'admins')),
  ADD COLUMN add_policy  text NOT NULL DEFAULT 'admins' CHECK (add_policy IN ('everyone', 'admins'));

ALTER TABLE conversation_members
  -- People added to a group only see messages sent after they joined.
  ADD COLUMN visible_from_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN added_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Membership changes ("Ana added Ben") are stored as system messages in the history.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'image', 'video', 'audio', 'voice', 'file', 'system'));
ALTER TABLE messages ADD COLUMN system_event jsonb;
ALTER TABLE messages ADD CONSTRAINT messages_system_event CHECK ((kind = 'system') = (system_event IS NOT NULL) OR deleted_at IS NOT NULL);

-- ------------------------------------------------------------------ privacy

ALTER TABLE privacy_settings
  -- Private accounts approve each follower; their posts and stories are for followers only.
  ADD COLUMN private_account boolean NOT NULL DEFAULT false,
  -- 'following' means people this user follows.
  ADD COLUMN who_can_add_to_groups text NOT NULL DEFAULT 'everyone' CHECK (who_can_add_to_groups IN ('everyone', 'following', 'nobody'));

ALTER TABLE reports DROP CONSTRAINT reports_subject_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_subject_type_check
  CHECK (subject_type IN ('user', 'message', 'post', 'comment', 'story', 'community', 'business', 'mini_app'));

-- ------------------------------------------------------------------ follows

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state       text NOT NULL CHECK (state IN ('active', 'pending')),
  created_at  timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  accepted_at timestamptz,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX follows_followee ON follows (followee_id, state);

-- ------------------------------------------------------------------ communities

CREATE TABLE communities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{2,39}$'),
  -- A channel is a community where only admins post; everyone else follows along.
  kind        text NOT NULL CHECK (kind IN ('community', 'channel')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  -- Private: joining needs approval, and only members see posts and the member list.
  visibility  text NOT NULL CHECK (visibility IN ('public', 'private')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  deleted_at  timestamptz
);
CREATE INDEX communities_search ON communities USING gin (to_tsvector('simple', name || ' ' || slug)) WHERE deleted_at IS NULL;

CREATE TABLE community_members (
  community_id uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
  state        text NOT NULL CHECK (state IN ('active', 'pending', 'banned')),
  created_at   timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id),
  CHECK (state = 'active' OR role = 'member')
);
CREATE INDEX community_members_user ON community_members (user_id, state);
CREATE UNIQUE INDEX community_one_owner ON community_members (community_id) WHERE role = 'owner';

-- ------------------------------------------------------------------ posts

CREATE TABLE posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Chosen by the device so a retried create returns the original post.
  client_id      text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  community_id   uuid REFERENCES communities(id) ON DELETE CASCADE,
  -- Community posts follow the community's visibility instead.
  audience       text NOT NULL CHECK (audience IN ('public', 'followers', 'only_me')),
  body           text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  shared_post_id uuid REFERENCES posts(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  edited_at      timestamptz,
  -- Removed by a community moderator: hidden from everyone but the author.
  removed_at     timestamptz,
  removed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  removal_reason text,
  UNIQUE (author_id, client_id),
  CHECK (community_id IS NULL OR audience = 'public')
);
CREATE INDEX posts_author ON posts (author_id, created_at DESC, id DESC);
CREATE INDEX posts_community ON posts (community_id, created_at DESC, id DESC) WHERE community_id IS NOT NULL;
CREATE INDEX posts_created ON posts (created_at DESC, id DESC);

CREATE TABLE post_media (
  post_id  uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  media_id uuid NOT NULL REFERENCES media(id),
  PRIMARY KEY (post_id, position)
);
CREATE INDEX post_media_media ON post_media (media_id);

CREATE TABLE post_likes (
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_likes_user ON post_likes (user_id);

CREATE TABLE post_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now())
);
CREATE INDEX post_comments_post ON post_comments (post_id, created_at, id);
CREATE INDEX post_comments_author ON post_comments (author_id);

-- ------------------------------------------------------------------ stories

CREATE TABLE stories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('text', 'image', 'video')),
  body       text NOT NULL DEFAULT '' CHECK (char_length(body) <= 500),
  background text NOT NULL DEFAULT '#3D5AFE' CHECK (background ~ '^#[0-9A-Fa-f]{6}$'),
  media_id   uuid REFERENCES media(id),
  audience   text NOT NULL CHECK (audience IN ('public', 'followers')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK ((kind = 'text') = (media_id IS NULL)),
  CHECK (kind <> 'text' OR char_length(body) > 0)
);
CREATE INDEX stories_author ON stories (author_id, expires_at);
CREATE INDEX stories_expiry ON stories (expires_at);
CREATE INDEX stories_media ON stories (media_id) WHERE media_id IS NOT NULL;

CREATE TABLE story_views (
  story_id  uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);

-- ------------------------------------------------------------------ visibility rules
-- One definition of "who can see what", used by every query that reads posts, stories
-- and their media, so the REST API, feeds and downloads cannot disagree.

CREATE FUNCTION blocked_either_way(a uuid, b uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = a AND blocked_id = b) OR (blocker_id = b AND blocked_id = a))
$$;

CREATE FUNCTION follows_actively(follower uuid, followee uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM follows WHERE follower_id = follower AND followee_id = followee AND state = 'active')
$$;

-- Personal audience: 'public' (followers only, if the account is private), 'followers', 'only_me'.
CREATE FUNCTION can_view_audience(viewer uuid, author uuid, audience text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT viewer = author OR (
    audience <> 'only_me'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = author AND u.state = 'active')
    AND NOT blocked_either_way(viewer, author)
    AND (
      (audience = 'public' AND NOT COALESCE((SELECT private_account FROM privacy_settings WHERE user_id = author), false))
      OR follows_actively(viewer, author)
    )
  )
$$;

CREATE FUNCTION can_view_community(viewer uuid, community uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM communities c
     WHERE c.id = community AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM community_members b WHERE b.community_id = c.id AND b.user_id = viewer AND b.state = 'banned')
       AND (c.visibility = 'public'
            OR EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.user_id = viewer AND m.state = 'active')))
$$;

CREATE FUNCTION can_view_post(viewer uuid, post uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM posts p
     WHERE p.id = post AND (
       p.author_id = viewer OR (
         p.removed_at IS NULL
         AND CASE WHEN p.community_id IS NULL THEN can_view_audience(viewer, p.author_id, p.audience)
             ELSE can_view_community(viewer, p.community_id)
                  AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.author_id AND u.state = 'active')
                  AND NOT blocked_either_way(viewer, p.author_id) END)))
$$;

CREATE FUNCTION can_view_story(viewer uuid, story uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM stories s
     WHERE s.id = story AND s.expires_at > now()
       AND can_view_audience(viewer, s.author_id, s.audience))
$$;
