CREATE TABLE onboarding_template (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  configured BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO onboarding_template(singleton) VALUES(true);
CREATE TABLE user_onboarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  guide_created BOOLEAN NOT NULL DEFAULT false,
  source_hash TEXT NOT NULL DEFAULT '',
  installed_hash TEXT NOT NULL DEFAULT '',
  asset_map JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_onboarding_doc_idx ON user_onboarding(doc_id);
