-- Mini-programs, as in WeChat: a small app a business builds from ready-made blocks (text,
-- buttons, its menu, opening hours, a map pin), opened inside SuperApp on the web and the
-- phone. Blocks, not code: nothing a business writes ever runs in a customer's app.
CREATE TABLE mini_programs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  -- What staff are editing.
  draft          jsonb NOT NULL,
  -- What customers see; NULL until first published, and again after unpublishing.
  published      jsonb,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mini_programs_live ON mini_programs (published_at DESC) WHERE published IS NOT NULL;

-- "Recently used", per person, as in WeChat's pull-down.
CREATE TABLE mini_program_recents (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mini_program_id uuid NOT NULL REFERENCES mini_programs(id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mini_program_id)
);
CREATE INDEX mini_program_recents_user ON mini_program_recents (user_id, opened_at DESC);
