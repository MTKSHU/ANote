import type {PoolClient} from "pg";
import {type User,documentRole,spaceRole} from "./auth.js";
import {digest} from "./database.js";
import {stable} from "@anote/sync-core";
import {noteHash} from "./mcp-model.js";
import {fail,identifier,text} from "./errors.js";

export async function noteMovePlan(sql:Pick<PoolClient,"query">,account:User,note:any,input:any){
  await documentRole(account,note.id,"manage",false,false,sql);
  if(note.archived)fail(409,"请先取消归档再移动笔记");
  const target=identifier(input.library_id),folder=input.folder_id?identifier(input.folder_id):null;
  if(target===note.space_id)fail(400,"请选择其他知识库，同库目录可直接调整");
  await spaceRole(account,target,"create",sql);
  const spaces=(await sql.query("SELECT id,name,kind,team_id,access_mode,created_by FROM spaces WHERE id=ANY($1::text[])",[[note.space_id,target]])).rows;
  const from=spaces.find(s=>s.id===note.space_id),destination=spaces.find(s=>s.id===target);
  if(!destination)fail(404,"目标知识库不存在");
  if(!from||from.kind!==destination.kind||(from.kind==="team"?from.team_id!==destination.team_id:from.created_by!==destination.created_by))fail(403,"笔记只能在同一团队的知识库之间，或本人个人知识库之间移动");
  if(note.created_by!==account.id&&(!from?.team_id||from.team_id!==destination.team_id))fail(403,"团队管理员可在本团队内整理他人笔记；跨团队或移入个人库须由作者操作");
  if(note.created_by!==account.id&&!(await sql.query("SELECT effective_space_role($1,$2) AS role",[note.created_by,target])).rows[0]?.role)fail(403,"作者无法访问目标知识库，请先授予其知识库访问权限");
  if(folder&&!(await sql.query("SELECT 1 FROM folders WHERE id=$1 AND space_id=$2 FOR KEY SHARE",[folder,target])).rowCount)fail(400,"目标目录不属于所选知识库");
  const visibility=input.visibility??"private";
  if(!["private","team"].includes(visibility)||(visibility==="team"&&destination.kind!=="team"))fail(400,"目标可见范围无效");
  const references=new Set<string>();const walk=(node:any)=>{if(node.type==="mediaResource"&&node.attrs?.assetId)references.add(node.attrs.assetId);if(node.type==="imageComparison")for(const image of node.attrs?.images||[])references.add(image.assetId);for(const child of node.content||[])walk(child);};walk(note.snapshot);
  const assets=(await sql.query("SELECT a.id,a.owner_doc_id FROM assets a WHERE a.owner_doc_id=$1 OR a.id=ANY($2::text[]) OR EXISTS(SELECT 1 FROM document_assets da WHERE da.doc_id=$1 AND da.asset_id=a.id)",[note.id,[...references]])).rows;
  if([...references].some(id=>!assets.some(a=>a.id===id)))fail(409,"笔记包含不可用的附件，请先修复附件引用再移动");
  if(assets.some(a=>a.owner_doc_id!==note.id))fail(409,"此笔记含其他笔记或旧素材库的共享附件，请先将附件保存为本笔记的独立附件后再移动");
  if((await sql.query("SELECT 1 FROM upload_sessions WHERE doc_id=$1 AND status='uploading' UNION ALL SELECT 1 FROM mcp_uploads WHERE doc_id=$1 AND status IN ('uploading','fetching','ready') AND expires_at>now() LIMIT 1",[note.id])).rowCount)fail(409,"仍有未完成的附件上传，请完成或取消后再移动");
  const counts=(await sql.query("SELECT (SELECT count(*)::int FROM document_collaborators WHERE doc_id=$1) AS collaborators,(SELECT count(*)::int FROM document_share_links WHERE doc_id=$1 AND revoked_at IS NULL) AS links",[note.id])).rows[0];
  const title=input.title===undefined?note.title:text(input.title,"笔记标题",200),tags=input.tags===undefined?note.tags:input.tags;
  if(!Array.isArray(tags)||tags.length>30||tags.some((tag:any)=>typeof tag!=="string"||tag.length>40))fail(400,"标签无效");
  const plan={action:"move",note_id:note.id,title,tags:[...new Set(tags)],from_library:from,destination,library_id:target,folder_id:folder,visibility,attachments:assets.length,collaborators_to_remove:counts.collaborators,external_links_to_revoke:counts.links,base_hash:digest(stable({note:noteHash(note),access_revision:note.access_revision})),notice:"笔记链接、正文、附件、评论和历史保留。原指定成员授权与外部链接将撤销；按目标知识库和所选可见范围重新授权。"};
  return {...plan,preview_hash:digest(stable(plan))};
}
