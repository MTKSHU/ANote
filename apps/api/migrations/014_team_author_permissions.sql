-- Team visibility grants contribution and comments, not blanket editing.
-- Existing explicit library/note grants remain intact; explicit library caps
-- still apply. A removed member cannot regain access through authorship.
CREATE OR REPLACE FUNCTION effective_space_role_with_deleted(actor TEXT,library TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN s.created_by=actor THEN 'admin' END
 WHEN t.archived OR tm.user_id IS NULL THEN NULL
 WHEN tm.role='admin' THEN 'admin'
 WHEN m.role IS NOT NULL THEN m.role
 WHEN s.access_mode='team' THEN 'contributor' END
 FROM spaces s JOIN users u ON u.id=actor AND u.active
 LEFT JOIN teams t ON t.id=s.team_id
 LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=actor
 LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=actor WHERE s.id=library
$$;
CREATE OR REPLACE FUNCTION effective_document_role_with_deleted(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
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
UPDATE documents SET access_revision=access_revision+1
 WHERE space_id IN (SELECT id FROM spaces WHERE kind='team');
