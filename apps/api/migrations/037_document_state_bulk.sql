-- Activation follows a verified complete current-state conversion.
CREATE TABLE document_state_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  default_encoding INTEGER NOT NULL DEFAULT 1 CHECK (default_encoding IN (1,2)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO document_state_settings(singleton) VALUES(true);

CREATE TABLE document_state_conversion_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  backup_hash TEXT NOT NULL,
  backup_bytes BIGINT NOT NULL,
  backup_filename TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  report JSONB NOT NULL DEFAULT '{}'
);
