ALTER TABLE spaces ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE spaces ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE spaces ADD COLUMN archived_by TEXT REFERENCES users(id);
ALTER TABLE spaces ADD COLUMN archive_revision BIGINT NOT NULL DEFAULT 0;
CREATE INDEX spaces_archived_idx ON spaces(archived) WHERE deleted_at IS NULL;

-- Preserve the original permission decision before capping archived notes.
CREATE FUNCTION effective_document_role_unarchived(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
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
CREATE OR REPLACE FUNCTION effective_document_role_with_deleted(actor TEXT,note TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN s.archived AND permission.role IS NOT NULL THEN 'viewer' ELSE permission.role END
 FROM documents d JOIN spaces s ON s.id=d.space_id
 CROSS JOIN LATERAL (SELECT effective_document_role_unarchived(actor,note) AS role) permission
 WHERE d.id=note
$$;

-- A final transactional guard covers a write racing the archive request.
-- KEY SHARE locks pair with the archive endpoint's explicit FOR UPDATE lock.
-- Already deleted parents/notes keep their existing recycle-bin retention policy.
CREATE FUNCTION guard_archived_library_content() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE library TEXT; ids TEXT[] := '{}'; doc_ids TEXT[] := '{}'; frozen BOOLEAN; removed TIMESTAMPTZ;
BEGIN
 IF TG_TABLE_NAME='document_collaborators' AND TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='documents' THEN
  IF TG_OP<>'INSERT' AND OLD.deleted_at IS NULL THEN ids:=array_append(ids,OLD.space_id); END IF;
  IF TG_OP<>'DELETE' AND NEW.deleted_at IS NULL THEN ids:=array_append(ids,NEW.space_id); END IF;
 ELSIF TG_TABLE_NAME='spaces' THEN
  ids:=array_append(ids,NEW.id);
 ELSIF TG_TABLE_NAME IN ('folders','experiments','meetings') THEN
  IF TG_OP<>'INSERT' THEN ids:=array_append(ids,OLD.space_id); END IF;
  IF TG_OP<>'DELETE' THEN ids:=array_append(ids,NEW.space_id); END IF;
 ELSIF TG_TABLE_NAME='assets' THEN
  IF TG_OP<>'INSERT' THEN
   IF OLD.owner_doc_id IS NULL THEN ids:=array_append(ids,OLD.space_id); ELSE doc_ids:=array_append(doc_ids,OLD.owner_doc_id); END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   IF NEW.owner_doc_id IS NULL THEN ids:=array_append(ids,NEW.space_id); ELSE doc_ids:=array_append(doc_ids,NEW.owner_doc_id); END IF;
  END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN doc_ids:=array_append(doc_ids,OLD.doc_id); END IF;
  IF TG_OP<>'DELETE' THEN doc_ids:=array_append(doc_ids,NEW.doc_id); END IF;
 END IF;
 ids:=ids||ARRAY(SELECT d.space_id FROM documents d WHERE d.id=ANY(doc_ids) AND d.deleted_at IS NULL);
 FOR library IN SELECT DISTINCT value FROM unnest(ids) value WHERE value IS NOT NULL ORDER BY value LOOP
  SELECT s.archived,s.deleted_at INTO frozen,removed FROM spaces s WHERE s.id=library FOR KEY SHARE;
  IF frozen AND removed IS NULL THEN
   -- Permission epochs and verified storage-codec maintenance preserve content.
   -- Avoid serializing OLD/NEW: ystate can be much larger than the visible note.
   IF TG_TABLE_NAME='documents' AND TG_OP='UPDATE' THEN
    IF ROW(NEW.space_id,NEW.folder_id,NEW.title,NEW.tags,NEW.snapshot,NEW.revision,NEW.archived,NEW.updated_at,NEW.visibility,NEW.created_by,NEW.created_at,NEW.deleted_at,NEW.deleted_by,NEW.trash_batch,NEW.pending_editor_ids,NEW.last_editor_ids)
       IS NOT DISTINCT FROM
       ROW(OLD.space_id,OLD.folder_id,OLD.title,OLD.tags,OLD.snapshot,OLD.revision,OLD.archived,OLD.updated_at,OLD.visibility,OLD.created_by,OLD.created_at,OLD.deleted_at,OLD.deleted_by,OLD.trash_batch,OLD.pending_editor_ids,OLD.last_editor_ids) THEN CONTINUE; END IF;
   END IF;
   RAISE EXCEPTION USING ERRCODE='PZA01',MESSAGE='知识库已归档，只能阅读，请先恢复知识库后再修改';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER library_archive_documents BEFORE INSERT OR UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_folders BEFORE INSERT OR UPDATE OR DELETE ON folders FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_comments BEFORE INSERT OR UPDATE OR DELETE ON comments FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_document_assets BEFORE INSERT OR UPDATE OR DELETE ON document_assets FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_document_collaborators BEFORE INSERT OR UPDATE OR DELETE ON document_collaborators FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
-- Preview generation can finish; original asset changes remain read-only.
CREATE TRIGGER library_archive_assets BEFORE INSERT OR DELETE OR UPDATE OF space_id,owner_doc_id,title,description,tags,filename,archived ON assets FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();

CREATE TRIGGER library_archive_space_settings BEFORE UPDATE OF name,description,access_mode,pinned,catalog_order,catalog_revision ON spaces FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_experiments BEFORE INSERT OR UPDATE OR DELETE ON experiments FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
CREATE TRIGGER library_archive_meetings BEFORE INSERT OR UPDATE OR DELETE ON meetings FOR EACH ROW EXECUTE FUNCTION guard_archived_library_content();
