-- Stage 6: one-to-one voice and video calls (WebRTC). The server only signals: audio and
-- video flow between the two devices, directly or through a TURN relay, encrypted with
-- DTLS-SRTP. The server never receives call media. It does keep call metadata (who called
-- whom, when, how long), shown in call history.

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  caller_id       uuid NOT NULL REFERENCES users(id),
  callee_id       uuid NOT NULL REFERENCES users(id),
  media           text NOT NULL CHECK (media IN ('audio', 'video')),
  -- ringing → accepted (answered, media connecting) → connected → ended. Any state can end.
  state           text NOT NULL DEFAULT 'ringing' CHECK (state IN ('ringing', 'accepted', 'connected', 'ended')),
  -- completed: hung up after connecting. cancelled: caller gave up while ringing.
  -- missed: nobody answered in time. declined. busy: the callee was on another call.
  -- failed: answered but media never connected (or a device reported it broke).
  -- connection_lost: a device dropped off and did not come back in time.
  end_reason      text CHECK (end_reason IN ('completed', 'cancelled', 'missed', 'declined', 'busy', 'failed', 'connection_lost')),
  ended_by        uuid REFERENCES users(id),
  -- The realtime connection (one app or browser tab) each side is using. Signalling goes
  -- only to these, so a person's other devices stop ringing once one of them answers.
  caller_conn     text NOT NULL,
  callee_conn     text,
  -- Set when that side's connection closes; cleared if it comes back (call.resume).
  caller_lost_at  timestamptz,
  callee_lost_at  timestamptz,
  -- Milliseconds, like other paged tables: history cursors carry millisecond timestamps.
  created_at      timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
  answered_at     timestamptz,
  connected_at    timestamptz,
  ended_at        timestamptz,
  CHECK (caller_id <> callee_id),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CHECK ((state IN ('accepted', 'connected')) <= (answered_at IS NOT NULL AND callee_conn IS NOT NULL)),
  CHECK ((state = 'connected') <= (connected_at IS NOT NULL))
);
CREATE INDEX calls_caller ON calls (caller_id, created_at DESC, id DESC);
CREATE INDEX calls_callee ON calls (callee_id, created_at DESC, id DESC);
CREATE INDEX calls_live ON calls (state, created_at) WHERE state <> 'ended';

-- One live call per person at a time. Both rows are inserted when a call starts and
-- removed when it ends; the primary key makes "already on a call" race-free.
CREATE TABLE call_lines (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE
);
CREATE INDEX call_lines_call ON call_lines (call_id);
