ALTER TABLE documents ADD COLUMN state_encoding INTEGER NOT NULL DEFAULT 1 CHECK (state_encoding IN (1,2));
ALTER TABLE documents ADD COLUMN state_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN state_compaction_checked_revision BIGINT;

-- Content revision does not advance when only collaboration metadata changes.
-- Conservatively invalidate shadow candidates on every state assignment.
CREATE FUNCTION advance_document_state_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.state_revision := OLD.state_revision + 1;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_state_revision BEFORE UPDATE OF ystate ON documents
FOR EACH ROW EXECUTE FUNCTION advance_document_state_revision();

CREATE TABLE document_state_archives (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_state_revision BIGINT NOT NULL,
  source_encoding INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  ystate BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(doc_id, source_state_revision)
);
