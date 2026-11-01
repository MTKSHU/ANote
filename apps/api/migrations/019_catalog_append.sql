-- New notes/folders join the existing mixed list at its end. Keep all explicit
-- user ordering; fill only entries created by clients before this trigger.
UPDATE spaces s SET catalog_order=s.catalog_order || ARRAY(
 SELECT key FROM (
   SELECT 'folder:'||f.id AS key,0 AS kind,f.position,f.name,NULL::timestamptz AS created_at FROM folders f WHERE f.space_id=s.id
   UNION ALL SELECT 'note:'||d.id,1,0,'',d.created_at FROM documents d WHERE d.space_id=s.id
 ) e WHERE NOT key=ANY(s.catalog_order) ORDER BY kind,position,name,created_at,key
);
CREATE OR REPLACE FUNCTION bump_catalog_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_key TEXT;
BEGIN
 item_key=CASE WHEN TG_TABLE_NAME='folders' THEN 'folder:' ELSE 'note:' END || COALESCE(NEW.id,OLD.id);
 UPDATE spaces SET catalog_revision=catalog_revision+1,
 catalog_order=CASE WHEN TG_OP='DELETE' THEN array_remove(catalog_order,item_key)
   WHEN TG_OP='INSERT' AND NOT item_key=ANY(catalog_order) THEN array_append(catalog_order,item_key)
   ELSE catalog_order END
 WHERE id=COALESCE(NEW.space_id,OLD.space_id);
 RETURN COALESCE(NEW,OLD);
END $$;
