import {createHash} from "node:crypto";
import {stable} from "@anote/sync-core";

type Row=Record<string,any>;
const readable=new Set(["admin","editor","reviewer","viewer"]);
const creating=new Set(["admin","editor","contributor"]);
const pick=(row:Row,keys:string[])=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
const fingerprint=(value:unknown)=>createHash("sha256").update(stable(value)).digest("hex");

/** Project SQL-authorized rows into a complete, permission-scoped offline view. */
export function inventoryView(libraryRows:Row[],documentRows:Row[],folderRows:Row[],teamRows:Row[],platform:Row,schema:number,generatedAt=new Date().toISOString()) {
  const libraries:Row[]=[],documents:Row[]=[],folders:Record<string,Row[]>=Object.create(null),catalogs:Record<string,Row>=Object.create(null);
  const notes=documentRows.filter(note=>readable.has(note.role));
  for(const library of libraryRows){
    const full=typeof library.role==="string"&&[...readable,"contributor"].includes(library.role);
    const rows=notes.filter(note=>note.space_id===library.id);
    if(!full&&!rows.length)continue;
    const scopedFolders=full?folderRows.filter(folder=>folder.space_id===library.id).map(folder=>pick(folder,["id","space_id","parent_id","name","position"])):[];
    // A note invitation grants no directory or enclosing-library metadata rights.
    // Keep only an opaque navigation shell; even ancestor names and total counts
    // would disclose unrelated private structure.
    const visibleLibrary=full?{
      ...pick(library,["id","name","description","kind","team_id","access_mode","created_by","created_at","pinned","sidebar_pinned","sidebar_pinned_at","role","archived","archived_at","archive_revision"]),
      offline_scope:"library",can_create:!library.archived&&creating.has(library.role),
      note_count:rows.filter(note=>!note.archived).length,folder_count:scopedFolders.length,
    }:{id:library.id,name:"共享笔记",kind:"personal",team_id:null,role:"viewer",archived:!!library.archived,archive_revision:library.archive_revision||0,offline_scope:"documents",can_create:false};
    libraries.push(visibleLibrary);folders[library.id]=scopedFolders;
    const visibleNotes:Row[]=rows.map(note=>{
      const metadata={...pick(note,["id","space_id","title","tags","role","archived","library_archived","library_archive_revision","revision","access_revision","updated_at","created_at","created_by","visibility"]),folder_id:full?(note.folder_id||null):null,can_manage:!library.archived&&note.role==="admin",can_edit:!library.archived&&!note.archived&&["admin","editor"].includes(note.role)};
      return {...metadata,offline_revision:fingerprint({metadata,assets:note.asset_versions||[]})};
    });
    documents.push(...visibleNotes);
    const entries=[...scopedFolders.map(folder=>({key:"folder:"+folder.id,kind:"folder",id:folder.id,parent_id:folder.parent_id||null})),...visibleNotes.filter(note=>!note.archived).map(note=>({key:"note:"+note.id,kind:"note",id:note.id,parent_id:note.folder_id}))];
    if(full){
      const order=new Map<string,number>((library.catalog_order||[]).map((key:string,index:number)=>[key,index]));
      entries.sort((a,b)=>(order.get(a.key)??Number.MAX_SAFE_INTEGER)-(order.get(b.key)??Number.MAX_SAFE_INTEGER)||a.key.localeCompare(b.key));
    }
    catalogs[library.id]={revision:full?String(library.catalog_revision||0):fingerprint(entries),items:entries};
  }
  const readableIds=new Set(documents.map(note=>note.id));
  const teams=teamRows.map(team=>({
    ...pick(team,["id","name","description","created_by","created_at","archived","role","allow_external_sharing","members_can_create_libraries","member_count"]),
    library_count:libraries.filter(library=>library.team_id===team.id&&library.offline_scope==="library").length,
    announcement_doc_id:readableIds.has(team.announcement_doc_id)?team.announcement_doc_id:null,
    pinned_note_ids:(team.pinned_note_ids||[]).filter((id:string)=>readableIds.has(id)),
  }));
  return {schema,complete:true as const,generatedAt,libraries,documents,folders,catalogs,teams,platform:pick(platform,["site_name","public_origin","auth_mode"])};
}
