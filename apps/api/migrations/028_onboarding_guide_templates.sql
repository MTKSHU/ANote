CREATE TABLE onboarding_guide_templates (
  guide_key TEXT PRIMARY KEY,
  source_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  configured BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO onboarding_guide_templates(guide_key) VALUES('chatgpt-mcp');
ALTER TABLE user_onboarding_guides ADD COLUMN asset_map JSONB NOT NULL DEFAULT '{}';
