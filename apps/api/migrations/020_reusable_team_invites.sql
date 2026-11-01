-- Only unused, active general invitations become reusable. Never reactivate
-- a previously consumed, revoked or expired link during the upgrade.
ALTER TABLE team_invites ADD COLUMN reusable BOOLEAN NOT NULL DEFAULT false;
UPDATE team_invites SET reusable=true
 WHERE email IS NULL AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at>now();

CREATE TABLE team_invite_acceptances (
 invite_id TEXT NOT NULL REFERENCES team_invites(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(invite_id,user_id)
);
