ALTER TABLE users DROP CONSTRAINT users_theme_check;
ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK(theme IN ('light','dark','auto'));
ALTER TABLE users ALTER COLUMN theme SET DEFAULT 'auto';
