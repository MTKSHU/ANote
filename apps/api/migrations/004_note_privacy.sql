-- Preserve existing shared documents; new notes are private.
ALTER TABLE documents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('private','team'));
ALTER TABLE documents ALTER COLUMN visibility SET DEFAULT 'private';
ALTER TABLE documents ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 1;
CREATE TABLE document_collaborators (
 doc_id TEXT NOT NULL REFERENCES documents(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK (role IN ('viewer','reviewer','editor')), PRIMARY KEY(doc_id,user_id)
);
CREATE TABLE document_share_links (
 id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id), token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);
CREATE INDEX document_share_links_doc_idx ON document_share_links(doc_id);
ALTER TABLE assets ADD COLUMN owner_doc_id TEXT REFERENCES documents(id);
ALTER TABLE assets DROP CONSTRAINT assets_storage_key_key;
CREATE INDEX assets_storage_key_idx ON assets(storage_key);
CREATE INDEX assets_owner_doc_idx ON assets(owner_doc_id);
ALTER TABLE upload_sessions ADD COLUMN doc_id TEXT REFERENCES documents(id);
