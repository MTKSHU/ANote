ALTER TABLE teams ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE teams ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE teams ADD COLUMN trash_batch TEXT;
ALTER TABLE spaces ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE spaces ADD COLUMN trash_batch TEXT;
ALTER TABLE documents ADD COLUMN trash_batch TEXT;
CREATE INDEX spaces_trash_idx ON spaces(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX teams_trash_idx ON teams(deleted_at) WHERE deleted_at IS NOT NULL;

ALTER FUNCTION effective_space_role(TEXT,TEXT) RENAME TO effective_space_role_with_deleted;
CREATE FUNCTION effective_space_role(actor TEXT,library TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT effective_space_role_with_deleted(actor,library) FROM spaces s LEFT JOIN teams t ON t.id=s.team_id
 WHERE s.id=library AND s.deleted_at IS NULL AND t.deleted_at IS NULL
$$;
-- Recovery can inspect a note's own deletion, but never bypass a deleted parent.
CREATE OR REPLACE FUNCTION effective_document_role_with_deleted(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN effective_space_role(actor,s.id) IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='admin' THEN 'admin'
 WHEN d.visibility='private' AND d.created_by<>actor AND c.role IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='viewer' THEN 'viewer'
 WHEN effective_space_role(actor,s.id)='reviewer' THEN CASE WHEN c.role='viewer' THEN 'viewer' ELSE 'reviewer' END
 WHEN d.visibility='private' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN d.created_by=actor THEN 'admin' ELSE COALESCE(c.role,effective_space_role(actor,s.id)) END
 FROM documents d JOIN spaces s ON s.id=d.space_id LEFT JOIN teams t ON t.id=s.team_id
 JOIN users u ON u.id=actor AND u.active
 LEFT JOIN document_collaborators c ON c.doc_id=d.id AND c.user_id=actor
 WHERE d.id=note AND s.deleted_at IS NULL AND t.deleted_at IS NULL
$$;
CREATE OR REPLACE FUNCTION effective_document_role(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT effective_document_role_with_deleted(actor,note) FROM documents WHERE id=note AND deleted_at IS NULL
$$;
