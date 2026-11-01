ALTER TABLE users ADD COLUMN local_password_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN membership_status TEXT NOT NULL DEFAULT 'active' CHECK(membership_status IN ('active','pending','disabled'));
UPDATE users SET membership_status='disabled' WHERE NOT active;
CREATE TABLE team_profile (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  name TEXT NOT NULL DEFAULT '研究团队',
  description TEXT NOT NULL DEFAULT ''
);
INSERT INTO team_profile(singleton) VALUES(true);
CREATE TABLE auth_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer,subject),
  UNIQUE(issuer,user_id)
);
CREATE TABLE oidc_requests (
  ticket_hash TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  session_hash TEXT,
  native_redirect TEXT,
  native_challenge TEXT,
  native_state TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE oidc_attempts (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  request JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE oidc_grants (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '60 seconds'
);
CREATE INDEX auth_identities_user_idx ON auth_identities(user_id);
