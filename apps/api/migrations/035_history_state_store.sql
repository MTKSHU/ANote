-- Historical collaboration states have their own immutable, document-scoped
-- object store. The current documents.ystate and visible snapshots are not
-- rewritten by this migration.
CREATE TABLE document_history_chunks (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes > 0 AND raw_bytes <= 65536),
  codec TEXT NOT NULL CHECK (codec = 'deflate-raw-v1'),
  compressed_sha256 TEXT NOT NULL CHECK (compressed_sha256 ~ '^[a-f0-9]{64}$'),
  payload BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, sha256)
);
CREATE TABLE document_history_manifests (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  raw_bytes BIGINT NOT NULL CHECK (raw_bytes >= 0 AND raw_bytes <= 134217728),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0 AND chunk_count <= 32769),
  format TEXT NOT NULL CHECK (format = 'anote-history-state-v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, sha256),
  CHECK ((raw_bytes = 0 AND chunk_count = 0) OR (raw_bytes > 0 AND chunk_count > 0))
);
CREATE TABLE document_history_manifest_chunks (
  doc_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  chunk_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK (raw_bytes > 0 AND raw_bytes <= 65536),
  PRIMARY KEY (doc_id, manifest_sha256, ordinal),
  FOREIGN KEY (doc_id, manifest_sha256)
    REFERENCES document_history_manifests(doc_id, sha256) ON DELETE CASCADE,
  FOREIGN KEY (doc_id, chunk_sha256)
    REFERENCES document_history_chunks(doc_id, sha256)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX document_history_chunk_references_idx
  ON document_history_manifest_chunks(doc_id, chunk_sha256);

ALTER TABLE document_versions
  ADD COLUMN history_state_storage TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN history_state_manifest_sha256 TEXT,
  ADD COLUMN history_state_verified_at TIMESTAMPTZ,
  ADD COLUMN history_state_legacy_released_at TIMESTAMPTZ,
  ALTER COLUMN ystate DROP NOT NULL;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_history_state_format CHECK (
  (history_state_storage = 'legacy' AND ystate IS NOT NULL AND history_state_manifest_sha256 IS NULL)
  OR
  (history_state_storage = 'chunked-v1' AND history_state_manifest_sha256 IS NOT NULL AND history_state_manifest_sha256 ~ '^[a-f0-9]{64}$')
);
ALTER TABLE document_versions ADD CONSTRAINT document_versions_history_state_manifest_fk
  FOREIGN KEY (doc_id, history_state_manifest_sha256)
  REFERENCES document_history_manifests(doc_id, sha256)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX document_versions_history_state_manifest_idx
  ON document_versions(doc_id, history_state_manifest_sha256)
  WHERE history_state_manifest_sha256 IS NOT NULL;
