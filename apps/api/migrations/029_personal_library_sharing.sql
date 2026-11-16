CREATE TABLE library_share_links (
 id TEXT PRIMARY KEY,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ,
 revoked_at TIMESTAMPTZ
);
CREATE INDEX library_share_links_space_idx ON library_share_links(space_id);
CREATE TABLE personal_library_members (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(space_id,user_id)
);

-- Personal library sharing grants read access only. Team roles are unchanged.
CREATE OR REPLACE FUNCTION effective_space_role_with_deleted(actor TEXT,library TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN s.created_by=actor THEN 'admin' WHEN pm.user_id IS NOT NULL THEN 'viewer' END
 WHEN t.archived OR tm.user_id IS NULL THEN NULL
 WHEN tm.role='admin' THEN 'admin'
 WHEN m.role IS NOT NULL THEN m.role
 WHEN s.access_mode='team' THEN 'contributor' END
 FROM spaces s JOIN users u ON u.id=actor AND u.active
 LEFT JOIN teams t ON t.id=s.team_id
 LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=actor
 LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=actor
 LEFT JOIN personal_library_members pm ON pm.space_id=s.id AND pm.user_id=actor WHERE s.id=library
$$;
CREATE OR REPLACE FUNCTION effective_document_role_with_deleted(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE COALESCE(c.role,CASE WHEN effective_space_role(actor,s.id)='viewer' THEN 'viewer' END) END
 WHEN effective_space_role(actor,s.id) IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='admin' THEN 'admin'
 WHEN d.visibility='private' AND d.created_by<>actor AND c.role IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='viewer' THEN 'viewer'
 WHEN effective_space_role(actor,s.id)='reviewer' THEN CASE WHEN c.role='viewer' THEN 'viewer' ELSE 'reviewer' END
 WHEN d.created_by=actor THEN 'admin'
 WHEN c.role IS NOT NULL THEN c.role
 WHEN effective_space_role(actor,s.id)='editor' THEN 'editor'
 ELSE 'reviewer' END
 FROM documents d JOIN spaces s ON s.id=d.space_id LEFT JOIN teams t ON t.id=s.team_id
 JOIN users u ON u.id=actor AND u.active
 LEFT JOIN document_collaborators c ON c.doc_id=d.id AND c.user_id=actor
 WHERE d.id=note AND s.deleted_at IS NULL AND t.deleted_at IS NULL
$$;
