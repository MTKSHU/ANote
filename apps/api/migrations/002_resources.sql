ALTER TABLE assets ADD COLUMN title TEXT NOT NULL DEFAULT '';
UPDATE assets SET title=filename;
ALTER TABLE assets ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE assets ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  actor TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK(bytes>0),
  hash TEXT NOT NULL,
  offset_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','complete','cancelled')),
  asset_id TEXT REFERENCES assets(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX upload_sessions_actor_idx ON upload_sessions(actor,space_id,updated_at DESC);
CREATE TABLE upload_chunks (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id),
  offset_bytes BIGINT NOT NULL,
  bytes INT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY(upload_id,offset_bytes)
);
ALTER TABLE jobs ADD COLUMN progress INT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN lease_id TEXT;
ALTER TABLE experiments ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;
