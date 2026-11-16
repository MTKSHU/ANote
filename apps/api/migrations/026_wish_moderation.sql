ALTER TABLE platform_settings ADD COLUMN wish_review_mode TEXT NOT NULL DEFAULT 'direct' CHECK (wish_review_mode IN ('direct','approval'));
ALTER TABLE wishes ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'published' CHECK (moderation_status IN ('pending','published','rejected'));
ALTER TABLE wishes ADD COLUMN reviewed_by TEXT REFERENCES users(id);
ALTER TABLE wishes ADD COLUMN reviewed_at TIMESTAMPTZ;
CREATE INDEX wishes_moderation_created_idx ON wishes(moderation_status,created_at DESC,id DESC);
