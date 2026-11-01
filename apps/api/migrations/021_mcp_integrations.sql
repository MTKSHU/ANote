-- OAuth grants and drafts are separate from platform login sessions.
CREATE TABLE mcp_clients (
 id TEXT PRIMARY KEY,
 metadata JSONB NOT NULL,
 secret_encrypted TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE mcp_authorizations (
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES mcp_clients(id),
 params JSONB NOT NULL,
 browser_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '10 minutes',
 consumed_at TIMESTAMPTZ
);
CREATE TABLE mcp_grants (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 client_id TEXT NOT NULL REFERENCES mcp_clients(id),
 resource TEXT NOT NULL,
 scopes TEXT[] NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_used_at TIMESTAMPTZ,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 days',
 revoked_at TIMESTAMPTZ
);
CREATE INDEX mcp_grants_user_idx ON mcp_grants(user_id,created_at);
CREATE TABLE mcp_codes (
 hash TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 challenge TEXT NOT NULL,
 redirect_uri TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes',
 used_at TIMESTAMPTZ
);
CREATE TABLE mcp_tokens (
 hash TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
 scopes TEXT[] NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ
);
CREATE INDEX mcp_tokens_grant_idx ON mcp_tokens(grant_id);
CREATE TABLE mcp_changes (
 id TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 doc_id TEXT,
 space_id TEXT NOT NULL REFERENCES spaces(id),
 base_hash TEXT NOT NULL,
 preview_hash TEXT NOT NULL,
 candidate JSONB NOT NULL,
 diff JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 applied_at TIMESTAMPTZ,
 operation_id TEXT,
 result JSONB
);
CREATE TABLE mcp_uploads (
 id TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES mcp_grants(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 space_id TEXT NOT NULL REFERENCES spaces(id),
 doc_id TEXT,
 filename TEXT NOT NULL,
 bytes BIGINT NOT NULL DEFAULT 0,
 expected_hash TEXT,
 offset_bytes BIGINT NOT NULL DEFAULT 0,
 hash TEXT,
 ticket_hash TEXT,
 ticket_expires_at TIMESTAMPTZ,
 status TEXT NOT NULL CHECK(status IN ('uploading','fetching','ready','attached','failed','cancelled')),
 metadata JSONB NOT NULL DEFAULT '{}',
 kind TEXT,
 mime TEXT,
 error TEXT,
 asset_id TEXT,
 staging_cleaned_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX mcp_uploads_cleanup_idx ON mcp_uploads(status,expires_at);
CREATE INDEX mcp_changes_expiry_idx ON mcp_changes(expires_at);
CREATE TABLE mcp_upload_chunks (
 upload_id TEXT NOT NULL REFERENCES mcp_uploads(id) ON DELETE CASCADE,
 offset_bytes BIGINT NOT NULL,
 bytes INT NOT NULL,
 hash TEXT NOT NULL,
 PRIMARY KEY(upload_id,offset_bytes)
);
ALTER TABLE document_versions ADD COLUMN integration_client TEXT;
