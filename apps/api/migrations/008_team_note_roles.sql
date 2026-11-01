-- Team library roles cap note permissions, including author-only drafts.
CREATE OR REPLACE FUNCTION effective_document_role(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.kind='personal' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN effective_space_role(actor,s.id) IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='admin' THEN 'admin'
 WHEN d.visibility='private' AND d.created_by<>actor AND c.role IS NULL THEN NULL
 WHEN effective_space_role(actor,s.id)='viewer' THEN 'viewer'
 WHEN effective_space_role(actor,s.id)='reviewer' THEN CASE WHEN c.role='viewer' THEN 'viewer' ELSE 'reviewer' END
 WHEN d.visibility='private' THEN CASE WHEN d.created_by=actor THEN 'admin' ELSE c.role END
 WHEN d.created_by=actor THEN 'admin' ELSE COALESCE(c.role,effective_space_role(actor,s.id)) END
 FROM documents d JOIN spaces s ON s.id=d.space_id JOIN users u ON u.id=actor AND u.active
 LEFT JOIN document_collaborators c ON c.doc_id=d.id AND c.user_id=actor WHERE d.id=note
$$;
