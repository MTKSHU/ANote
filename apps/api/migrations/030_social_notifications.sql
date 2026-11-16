CREATE TABLE friendships (
  id text PRIMARY KEY,
  user_low text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_low,user_high),
  CHECK(user_low<user_high),
  CHECK(requested_by IN (user_low,user_high))
);
CREATE TABLE notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('mention','comment','friend_request','friend_accepted')),
  doc_id text REFERENCES documents(id) ON DELETE CASCADE,
  comment_id text REFERENCES comments(id) ON DELETE CASCADE,
  friendship_id text REFERENCES friendships(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(user_id,dedupe_key)
);
CREATE INDEX notifications_user_created ON notifications(user_id,created_at DESC);
CREATE INDEX notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
