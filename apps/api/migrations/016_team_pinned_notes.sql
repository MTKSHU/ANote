ALTER TABLE teams ADD COLUMN pinned_note_ids TEXT[] NOT NULL DEFAULT '{}';
