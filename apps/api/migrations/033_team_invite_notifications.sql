ALTER TABLE team_invites ADD COLUMN target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE team_invites ADD COLUMN declined_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN invite_id TEXT REFERENCES team_invites(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK(kind IN ('mention','comment','friend_request','friend_accepted','team_invite'));
CREATE INDEX notifications_invite_idx ON notifications(invite_id) WHERE invite_id IS NOT NULL;
