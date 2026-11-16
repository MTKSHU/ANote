ALTER TABLE documents ADD COLUMN last_editor_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE documents d SET last_editor_ids=CASE
  WHEN cardinality(d.pending_editor_ids)>0 THEN d.pending_editor_ids
  ELSE COALESCE((SELECT v.editor_ids FROM document_versions v WHERE v.doc_id=d.id AND cardinality(v.editor_ids)>0 ORDER BY v.created_at DESC,v.id DESC LIMIT 1),'{}'::text[])
END;
