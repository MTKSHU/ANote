-- Persist actual contributors between history snapshots. Old versions stay
-- untouched: a missing historical actor cannot be reconstructed safely.
ALTER TABLE documents ADD COLUMN pending_editor_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE document_versions ADD COLUMN editor_ids TEXT[] NOT NULL DEFAULT '{}';
