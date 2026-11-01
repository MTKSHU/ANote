ALTER TABLE spaces ADD COLUMN catalog_order TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE spaces ADD COLUMN catalog_revision BIGINT NOT NULL DEFAULT 0;
UPDATE spaces s SET catalog_order=ARRAY(
 SELECT key FROM (
 SELECT 'folder:'||f.id AS key,0 AS kind,f.position AS position,f.name AS name,NULL::timestamptz AS updated_at FROM folders f WHERE f.space_id=s.id
 UNION ALL SELECT 'note:'||d.id,1,0,'',d.updated_at FROM documents d WHERE d.space_id=s.id
 ) items ORDER BY kind,position,name,updated_at DESC,key
);
CREATE FUNCTION bump_catalog_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE spaces SET catalog_revision=catalog_revision+1 WHERE id=COALESCE(NEW.space_id,OLD.space_id);
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER folder_catalog_changed AFTER INSERT OR DELETE OR UPDATE OF parent_id ON folders FOR EACH ROW EXECUTE FUNCTION bump_catalog_revision();
CREATE TRIGGER note_catalog_changed AFTER INSERT OR DELETE OR UPDATE OF folder_id ON documents FOR EACH ROW EXECUTE FUNCTION bump_catalog_revision();
