CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('admin','editor','reviewer','viewer')),
  PRIMARY KEY(space_id,user_id)
);
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  parent_id TEXT REFERENCES folders(id),
  name TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0
);
CREATE INDEX folders_space_idx ON folders(space_id);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  folder_id TEXT REFERENCES folders(id),
  title TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id),
  ystate BYTEA NOT NULL,
  snapshot JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  archived BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_space_updated_idx ON documents(space_id,updated_at DESC);
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  snapshot JSONB NOT NULL,
  ystate BYTEA NOT NULL,
  hash TEXT NOT NULL,
  author TEXT REFERENCES users(id),
  source TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_versions_doc_idx ON document_versions(doc_id,created_at DESC);
CREATE TABLE sync_bases (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  actor TEXT NOT NULL REFERENCES users(id),
  snapshot JSONB NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sync_operations (
  doc_id TEXT NOT NULL REFERENCES documents(id),
  actor TEXT NOT NULL REFERENCES users(id),
  op_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status INT NOT NULL,
  result JSONB NOT NULL,
  PRIMARY KEY(doc_id,actor,op_id)
);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  actor TEXT NOT NULL REFERENCES users(id),
  markdown TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  parent_id TEXT REFERENCES comments(id),
  author TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  anchor JSONB,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comments_doc_idx ON comments(doc_id,created_at);
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  submitter TEXT NOT NULL REFERENCES users(id),
  reviewer TEXT NOT NULL REFERENCES users(id),
  snapshot JSONB NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  hash TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assets_space_created_idx ON assets(space_id,created_at DESC);
CREATE TABLE document_assets (
  doc_id TEXT NOT NULL REFERENCES documents(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  PRIMARY KEY(doc_id,asset_id)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id),
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','failed')),
  attempts INT NOT NULL DEFAULT 0,
  error TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX jobs_pending_idx ON jobs(status,created_at);
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  model TEXT NOT NULL DEFAULT '',
  dataset TEXT NOT NULL DEFAULT '',
  parameters JSONB NOT NULL DEFAULT '{}',
  environment TEXT NOT NULL DEFAULT '',
  metrics JSONB NOT NULL DEFAULT '{}',
  document_id TEXT REFERENCES documents(id),
  asset_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  agenda TEXT NOT NULL DEFAULT '',
  document_id TEXT REFERENCES documents(id),
  asset_ids TEXT[] NOT NULL DEFAULT '{}',
  actions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
