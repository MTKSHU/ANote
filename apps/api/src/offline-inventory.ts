import {transaction} from "./database.js";
import {type User} from "./auth.js";
import {platformConfig} from "./platform.js";
import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {inventoryView} from "./offline-inventory-view.js";

/** Same effective roles as documentRole/spaceRole; platform admin is no bypass. */
export async function offlineInventory(account:User){
  return transaction(async sql=>{
    // A complete result is authoritative for revocation. All metadata must come
    // from one permission snapshot rather than several independently paged APIs.
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const documents=(await sql.query(`
      SELECT d.id,d.space_id,d.folder_id,d.title,d.tags,d.archived,d.revision,d.access_revision,
        d.updated_at,d.created_at,d.created_by,d.visibility,
        (SELECT archived FROM spaces WHERE id=d.space_id) AS library_archived,
        (SELECT archive_revision FROM spaces WHERE id=d.space_id) AS library_archive_revision,effective_document_role($1,d.id) AS role,
        COALESCE((SELECT jsonb_agg(jsonb_build_array(a.id,a.hash,a.bytes,a.revision,a.updated_at,a.status,a.metadata) ORDER BY a.id)
          FROM assets a WHERE a.id IN (SELECT ref#>>'{}' FROM jsonb_path_query(d.snapshot,'$.**.assetId') ref)
          AND CASE WHEN a.owner_doc_id IS NOT NULL THEN effective_document_role($1,a.owner_doc_id) IS NOT NULL
            ELSE effective_space_role($1,a.space_id) IS NOT NULL
              OR EXISTS(SELECT 1 FROM document_assets da WHERE da.asset_id=a.id AND effective_document_role($1,da.doc_id) IS NOT NULL)
              OR (a.space_id IS NULL AND EXISTS(
                SELECT 1 FROM experiments e WHERE a.id=ANY(e.asset_ids) AND effective_space_role($1,e.space_id) IS NOT NULL
                UNION ALL SELECT 1 FROM meetings m WHERE a.id=ANY(m.asset_ids) AND effective_space_role($1,m.space_id) IS NOT NULL))
            END),'[]'::jsonb) AS asset_versions
      FROM documents d WHERE effective_document_role($1,d.id) IS NOT NULL
      ORDER BY d.updated_at DESC,d.id`,[account.id])).rows;
    const documentLibraries=[...new Set(documents.map(note=>note.space_id))];
    const libraries=(await sql.query(`
      SELECT s.id,s.name,s.description,s.kind,s.team_id,s.access_mode,s.created_by,s.created_at,s.pinned,s.archived,s.archived_at,s.archive_revision,
        s.catalog_order,s.catalog_revision,effective_space_role($1,s.id) AS role,
        p.created_at IS NOT NULL AS sidebar_pinned,p.created_at AS sidebar_pinned_at
      FROM spaces s LEFT JOIN user_library_pins p ON p.user_id=$1 AND p.space_id=s.id
      WHERE effective_space_role($1,s.id) IS NOT NULL OR s.id=ANY($2::text[])
      ORDER BY s.pinned DESC,s.created_at,s.id`,[account.id,documentLibraries])).rows;
    const folders=(await sql.query(`SELECT f.id,f.space_id,f.parent_id,f.name,f.position
      FROM folders f WHERE effective_space_role($1,f.space_id) IS NOT NULL ORDER BY f.position,f.name,f.id`,[account.id])).rows;
    const teams=(await sql.query(`SELECT t.id,t.name,t.description,t.created_by,t.created_at,t.archived,
        t.allow_external_sharing,t.members_can_create_libraries,t.announcement_doc_id,t.pinned_note_ids,m.role,
        (SELECT count(*)::int FROM team_members member WHERE member.team_id=t.id) AS member_count
      FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=$1
      WHERE t.deleted_at IS NULL ORDER BY t.created_at,t.id`,[account.id])).rows;
    return inventoryView(libraries,documents,folders,teams,platformConfig(),EDITOR_SCHEMA_VERSION);
  });
}
