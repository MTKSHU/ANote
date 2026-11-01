ALTER TABLE documents ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN deleted_by TEXT REFERENCES users(id);
CREATE INDEX documents_trash_idx ON documents(deleted_at) WHERE deleted_at IS NOT NULL;
-- Keep the established role calculation available only to authorized recovery operations.
ALTER FUNCTION effective_document_role(TEXT,TEXT) RENAME TO effective_document_role_with_deleted;
CREATE FUNCTION effective_document_role(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT effective_document_role_with_deleted(actor,note) FROM documents WHERE id=note AND deleted_at IS NULL
$$;
