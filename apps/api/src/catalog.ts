import { db, transaction } from "./database.js";
import { type User, spaceRole } from "./auth.js";
import { fail, identifier } from "./errors.js";
import { moveCatalog, unwrapCatalog, type CatalogEntry } from "@anote/sync-core/catalog";

async function entries(client: any, id: string): Promise<CatalogEntry[]> {
  return (await client.query(`SELECT 'folder:'||id AS key,'folder' AS kind,id,parent_id FROM folders WHERE space_id=$1
    UNION ALL SELECT 'note:'||id,'note',id,folder_id FROM documents WHERE space_id=$1 ORDER BY key`, [id])).rows;
}
export async function catalog(account: User, id: string) {
  await spaceRole(account, id);
  return transaction(async client => {
    const space = (await client.query("SELECT catalog_order,catalog_revision FROM spaces WHERE id=$1 FOR SHARE", [id])).rows[0];
    const all = await entries(client, id);
    const visible = new Set((await client.query("SELECT id FROM documents WHERE space_id=$1 AND NOT archived AND effective_document_role($2,id) IS NOT NULL", [id,account.id])).rows.map(r => r.id));
    const order: string[] = [...new Set<string>([...space.catalog_order,...all.map(e => e.key)])];
    return { revision: String(space.catalog_revision), items: all.filter(e => e.kind === "folder" || visible.has(e.id)).sort((a,b) => order.indexOf(a.key)-order.indexOf(b.key)) };
  });
}
export async function reorder(account: User, id: string, input: any) {
  await spaceRole(account, id, "create");
  const kind = input?.kind;
  if (!["folder","note"].includes(kind)) fail(400,"目录条目无效");
  const source = identifier(input.id), parent = input.parent_id ? identifier(input.parent_id) : null;
  const before = input.before == null ? null : String(input.before);
  await transaction(async client => {
    const space = (await client.query("SELECT *,effective_space_role($2,id) AS role FROM spaces WHERE id=$1 FOR UPDATE", [id,account.id])).rows[0];
    if (!space || !["admin","editor","contributor"].includes(space.role)) fail(403,"知识库权限已变更");
    if (String(input.revision) !== String(space.catalog_revision)) fail(409,"列表已被更新，请刷新后重试");
    if (kind === "folder" && space.role !== "admin") fail(403,"仅知识库管理员可调整目录");
    const all = await entries(client,id);
    const entry = all.find(e => e.key === kind+":"+source);
    if (!entry) fail(404,"目录或笔记不存在");
    if (kind === "note" && !(await client.query("SELECT 1 FROM documents WHERE id=$1 AND NOT archived AND effective_document_role($2,id)='admin'", [source,account.id])).rowCount) fail(403,"仅作者或管理员可移动此笔记");
    if (before?.startsWith("note:") && !(await client.query("SELECT 1 FROM documents WHERE id=$1 AND space_id=$3 AND NOT archived AND effective_document_role($2,id) IS NOT NULL", [before.slice(5),account.id,id])).rowCount) fail(400,"排序目标不可访问");
    let order: string[];
    try { order = moveCatalog(all,space.catalog_order,entry!.key,parent,before); }
    catch (error) { fail(400,(error as Error).message); }
    if (entry!.parent_id !== parent) {
      if (kind === "folder") await client.query("UPDATE folders SET parent_id=$2 WHERE id=$1",[source,parent]);
      else await client.query("UPDATE documents SET folder_id=$2,updated_at=now() WHERE id=$1",[source,parent]);
    }
    await client.query("UPDATE spaces SET catalog_order=$2,catalog_revision=catalog_revision+1 WHERE id=$1", [id,order!]);
  });
  return catalog(account,id);
}
export async function removeFolder(account: User,id:string,folderId:string) {
  await spaceRole(account,id,"manage");
  await transaction(async client=>{
    const space=(await client.query("SELECT *,effective_space_role($2,id) AS role FROM spaces WHERE id=$1 FOR UPDATE",[id,account.id])).rows[0];
    if(!space || space.role !== "admin")fail(403,"仅知识库管理员可删除目录");
    const all=await entries(client,id);
    if(!all.some(e=>e.kind === "folder" && e.id === folderId))fail(404,"目录不存在");
    const next=unwrapCatalog(all,space.catalog_order,folderId);
    await client.query("UPDATE documents SET folder_id=$2 WHERE folder_id=$1 AND space_id=$3",[folderId,next.parent_id,id]);
    await client.query("UPDATE folders SET parent_id=$2 WHERE parent_id=$1 AND space_id=$3",[folderId,next.parent_id,id]);
    await client.query("DELETE FROM folders WHERE id=$1 AND space_id=$2",[folderId,id]);
    await client.query("UPDATE spaces SET catalog_order=$2,catalog_revision=catalog_revision+1 WHERE id=$1",[id,next.order]);
    await client.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'folder.delete',$2,$3)",[account.id,folderId,{space_id:id,parent_id:next.parent_id,contents_preserved:true}]);
  });
  return {ok:true};
}
