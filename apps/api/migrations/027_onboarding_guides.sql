CREATE TABLE user_onboarding_guides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guide_key TEXT NOT NULL,
  doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  guide_created BOOLEAN NOT NULL DEFAULT false,
  source_hash TEXT NOT NULL DEFAULT '',
  installed_hash TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,guide_key)
);
CREATE INDEX user_onboarding_guides_doc_idx ON user_onboarding_guides(doc_id);
