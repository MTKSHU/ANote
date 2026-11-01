ALTER TABLE experiments ADD COLUMN input_asset_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE experiments ADD COLUMN output_asset_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE experiments ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE experiments ADD COLUMN status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','running','complete','failed'));
ALTER TABLE experiments ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE meetings ADD COLUMN status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','held','cancelled'));
ALTER TABLE meetings ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX experiments_space_idx ON experiments(space_id,updated_at DESC);
CREATE INDEX meetings_space_idx ON meetings(space_id,starts_at DESC);
