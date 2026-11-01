import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import {blockId,textOf,EDITOR_SCHEMA_VERSION,type RichDoc,type RichNode} from "@anote/document-model";
import {stable} from "@anote/sync-core";
import {Documents} from "./documents.js";
import {db,digest} from "./database.js";
import {documentRole,spaceRole,readableDocumentSQL} from "./auth.js";
import * as workspace from "./workspaces.js";
import {assetFor,assetView,localAssetPath} from "./assets.js";
import {mcpOrigin,requireScope,type McpIdentity} from "./mcp-auth.js";
import {noteHash,editBlocks,validateRichDocument,changeDiff,editorRules} from "./mcp-model.js";
import {staged,promoteUpload,beginUpload,completeUpload,uploadStatus,cancelUpload,importChatFile,readAsset} from "./mcp-files.js";
import {acquireDocument} from "./document-lock.js";
import {fail,identifier,text} from "./errors.js";

function page(input:any){const offset=input.offset??0,limit=input.limit??20;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)fail(400,"分页位置或大小无效");return {offset,limit};}
type AssetPlan={kind:"existing"|"copy"|"upload";id:string;source_id:string;hash:string};
const MEDIA_LAYOUT_PLAN_VERSION=1;
const hasMedia=(node:RichNode):boolean=>node.type==="mediaResource"||!!node.content?.some(hasMedia);
export class McpService {
  constructor(private documents:Documents){}
  async assetPlans(identity:McpIdentity,value:RichDoc,space:string,doc:string|null){
    const plans:AssetPlan[]=[],resolved=new Map<string,any>();
    async function resolve(id:string){
      identifier(id);if(resolved.has(id))return resolved.get(id);
      let asset:any,kind:AssetPlan["kind"]="existing",finalId=id;
      if((await db.query("SELECT 1 FROM assets WHERE id=$1",[id])).rowCount){
        asset=await assetFor(identity.account,id);
        if(asset.space_id!==space&&asset.space_id!==null)fail(403,"附件不属于目标知识库");
        if(asset.owner_doc_id&&asset.owner_doc_id!==doc){requireScope(identity,"assets:write");kind="copy";finalId=randomUUID();}
        if(asset.space_id===null&&asset.owner_doc_id!==doc){requireScope(identity,"assets:write");kind="copy";finalId=randomUUID();}
      }else{
        asset=await staged(identity,id,space,doc);if(asset.status!=="ready")fail(409,"附件尚未准备完成");kind="upload";
      }
      plans.push({kind,id:finalId,source_id:id,hash:asset.hash});
      const metadata={...asset,id:finalId,src:"/api/assets/"+finalId+"/file",localPath:localAssetPath({...asset,id:finalId})};resolved.set(id,metadata);return metadata;
    }
    async function walk(node:RichNode){
      if(node.type==="mediaResource"){
        const row=await resolve(node.attrs?.assetId),a=node.attrs||{};
        node.attrs={blockId:a.blockId,assetId:row.id,src:row.src,localPath:row.localPath,title:typeof a.title==="string"?a.title.slice(0,1000):row.filename,kind:row.kind,mime:row.mime,bytes:Number(row.bytes),hash:row.hash,widthPercent:a.widthPercent??null,alignment:a.alignment??"center"};
      }
      if(node.type==="imageComparison"){
        if(!Array.isArray(node.attrs?.images))fail(400,"图片对比内容无效");
        const images=[];for(const image of node.attrs!.images){const row=await resolve(image?.assetId);if(row.kind!=="image")fail(400,"多图对比只能引用图片");images.push({assetId:row.id,src:row.src,localPath:row.localPath,hash:row.hash,label:typeof image.label==="string"?image.label.slice(0,200):row.filename});}node.attrs!.images=images;
      }
      for(const child of node.content||[])await walk(child);
    }
    await walk(value);return plans;
  }
  async prepare(identity:McpIdentity,input:any){
    requireScope(identity,"notes:write");if(input.schema_version!==EDITOR_SCHEMA_VERSION)fail(409,"请先获取编辑规则并使用当前格式版本");
    let before:any,space:string,doc:string|null=null,folder:string|null=null;
    if(input.note_id){
      doc=identifier(input.note_id);await documentRole(identity.account,doc,"edit");before=await this.documents.get(identity.account,doc);space=before.space_id;folder=before.folder_id;
      if(typeof input.base_hash!=="string"||input.base_hash!==noteHash(before))fail(409,"读取后的笔记已更新，请重新读取");
    }else{
      space=identifier(input.library_id);await spaceRole(identity.account,space,"create");folder=input.folder_id?identifier(input.folder_id):null;
      if(folder&&!(await db.query("SELECT 1 FROM folders WHERE id=$1 AND space_id=$2",[folder,space])).rowCount)fail(400,"目录不属于目标知识库");
      before={snapshot:{type:"doc",content:[]},title:"",tags:[],space_id:space,folder_id:folder};
    }
    const title=input.title===undefined?(before.title||"未命名笔记"):text(input.title,"笔记标题",200),tags=input.tags===undefined?before.tags:input.tags;
    if(!Array.isArray(tags)||tags.length>30||tags.some((t:any)=>typeof t!=="string"||t.length>40))fail(400,"标签无效");
    const snapshot=editBlocks(before.snapshot,input.operations||[]),assets=await this.assetPlans(identity,snapshot,space,doc);
    const candidate={snapshot:validateRichDocument(snapshot),title,tags:[...new Set(tags)],folder_id:folder,space_id:space,assets,new_note_id:doc?undefined:randomUUID(),media_layout_version:MEDIA_LAYOUT_PLAN_VERSION};
    const diff=changeDiff(before,candidate),removed=diff.filter(c=>c.action==="delete").map(c=>c.block_id);
    const affectedComments=doc?(await db.query("SELECT id,body,anchor FROM comments WHERE doc_id=$1 AND NOT resolved",[doc])).rows.filter(c=>removed.includes(c.anchor?.blockId)||diff.some(d=>d.block_id&&c.anchor&&!c.anchor.blockId)):[];
    const id=randomUUID(),hash=digest(stable(candidate));
    const row=(await db.query("INSERT INTO mcp_changes(id,grant_id,user_id,doc_id,space_id,base_hash,preview_hash,candidate,diff) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING expires_at",[id,identity.grantId,identity.account.id,doc,space,doc?noteHash(before):"new",hash,candidate,{changes:diff,affected_comments:affectedComments.map(c=>({id:c.id,body:c.body,may_lose_anchor:true}))}])).rows[0];
    return {change_id:id,preview_hash:hash,expires_at:row.expires_at,action:doc?"edit":"create",note_id:doc,library_id:space,title,diff,affected_comments:affectedComments.map(c=>({id:c.id,body:c.body,may_lose_anchor:true})),notice:"正式笔记尚未修改。向用户展示上述差异；用户确认后才调用 apply_changes。预览过期或笔记有新修改时必须重新准备。"};
  }
  async apply(identity:McpIdentity,input:any){
    requireScope(identity,"notes:write");const id=identifier(input.change_id),operation=text(input.operation_id,"操作 ID",100);if(!/^[-\w]{10,100}$/.test(operation))fail(400,"操作 ID 无效");
    const release=await acquireDocument("mcp-change:"+id);
    try{
      const row=(await db.query("SELECT * FROM mcp_changes WHERE id=$1 AND grant_id=$2 AND user_id=$3",[id,identity.grantId,identity.account.id])).rows[0];
      if(!row)fail(404,"变更预览不存在");if(input.preview_hash!==row.preview_hash)fail(409,"提交内容与展示的预览不一致");
      if(row.applied_at)return {...row.result,replayed:true};if(new Date(row.expires_at).getTime()<=Date.now())fail(409,"变更预览已过期，请重新准备");
      const candidate=row.candidate,docId=row.doc_id||candidate.new_note_id;
      if(candidate.kind==="note-move"){
        const result=await this.documents.move(identity.account,docId,candidate.plan,async(sql,result)=>{
          if(!(await sql.query("SELECT 1 FROM mcp_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",[identity.grantId,identity.account.id])).rowCount)fail(401,"AI 连接已撤销或过期");
          const draft=(await sql.query("SELECT applied_at FROM mcp_changes WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!draft||draft.applied_at)fail(409,"移动已提交");
          await sql.query("UPDATE mcp_changes SET applied_at=now(),operation_id=$2,result=$3 WHERE id=$1",[id,operation,result]);
          await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'integration.note.move',$2,$3)",[identity.account.id,docId,{client_id:identity.clientId,client_name:identity.clientName,change_id:id}]);
        });
        return {...result,url:mcpOrigin()+result.url};
      }
      if(candidate.media_layout_version!==MEDIA_LAYOUT_PLAN_VERSION&&hasMedia(candidate.snapshot))fail(409,"媒体排版规则已更新，请重新读取笔记并生成变更预览");
      const extra=async(sql:PoolClient,result:any)=>{
        const grant=await sql.query("SELECT id FROM mcp_grants WHERE id=$1 AND user_id=$2 AND resource=$3 AND revoked_at IS NULL AND expires_at>now() FOR SHARE",[identity.grantId,identity.account.id,mcpOrigin()+"/mcp"]);if(!grant.rowCount)fail(401,"AI 连接已撤销或过期");
        const draft=(await sql.query("SELECT applied_at FROM mcp_changes WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!draft||draft.applied_at)fail(409,"变更已提交");
        for(const plan of candidate.assets as AssetPlan[]){
          if(plan.kind==="upload")await promoteUpload(sql,identity,plan.source_id,docId,row.space_id,row.doc_id);
          else{
            const source=await assetFor(identity.account,plan.source_id,"read",sql);if(source.hash!==plan.hash)fail(409,"引用附件已变化，请重新准备");
            if(plan.kind==="copy"){
              requireScope(identity,"assets:write");
              await sql.query("INSERT INTO assets(id,space_id,created_by,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,owner_doc_id) SELECT $1,$2,$3,filename,title,description,tags,mime,bytes,hash,storage_key,kind,metadata,status,$4 FROM assets WHERE id=$5",[plan.id,row.space_id,identity.account.id,docId,plan.source_id]);
            }
          }
          await sql.query("INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[docId,plan.id]);
        }
        await sql.query("UPDATE mcp_changes SET applied_at=now(),operation_id=$2,result=$3 WHERE id=$1",[id,operation,result]);
        await sql.query("INSERT INTO audit_events(actor,action,target,detail) VALUES($1,'integration.note.save',$2,$3)",[identity.account.id,docId,{client_id:identity.clientId,client_name:identity.clientName,change_id:id}]);
      };
      const result=row.doc_id?await this.documents.commitIntegration(identity.account,docId,row.base_hash,candidate,identity.clientName,extra):await this.documents.createIntegration(identity.account,docId,row.space_id,candidate.folder_id,candidate,identity.clientName,extra);
      return {...result,url:mcpOrigin()+result.url};
    }finally{release();}
  }
  async call(name:string,identity:McpIdentity,input:any){
    if(name==="get_context"){requireScope(identity,"notes:read");return {user:{id:identity.account.id,name:identity.account.name},application:identity.clientName,scopes:identity.scopes,...editorRules()};}
    if(name==="get_editor_rules"){requireScope(identity,"notes:read");return editorRules();}
    if(name==="list_libraries"){requireScope(identity,"notes:read");const {offset,limit}=page(input),all=await workspace.spaces(identity.account);return {items:all.slice(offset,offset+limit),next_offset:all.length>offset+limit?offset+limit:null};}
    if(name==="list_notes"){
      requireScope(identity,"notes:read");const {offset,limit}=page(input),all=await this.documents.list(identity.account,input.library_id?identifier(input.library_id):undefined,typeof input.query==="string"?input.query:"",input.archived===true);
      return {items:all.slice(offset,offset+limit),next_offset:all.length>offset+limit?offset+limit:null};
    }
    if(name==="read_note"){
      requireScope(identity,"notes:read");const note=await this.documents.get(identity.account,identifier(input.note_id)),{offset,limit}=page(input);
      return {note_id:note.id,title:note.title,tags:note.tags,library_id:note.space_id,folder_id:note.folder_id,role:note.role,archived:note.archived,schema_version:EDITOR_SCHEMA_VERSION,base_hash:noteHash(note),outline:note.snapshot.content.slice(0,1000).map((n:RichNode)=>({block_id:blockId(n),type:n.type,text:textOf(n).slice(0,120)})),blocks:note.snapshot.content.slice(offset,offset+limit),next_offset:note.snapshot.content.length>offset+limit?offset+limit:null};
    }
    if(name==="prepare_note_move"){
      requireScope(identity,"notes:write");const docId=identifier(input.note_id),plan=await this.documents.previewMove(identity.account,docId,input),id=randomUUID();
      const candidate={kind:"note-move",plan},hash=digest(stable(candidate));
      const row=(await db.query("INSERT INTO mcp_changes(id,grant_id,user_id,doc_id,space_id,base_hash,preview_hash,candidate,diff) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING expires_at",[id,identity.grantId,identity.account.id,docId,plan.library_id,plan.base_hash,hash,candidate,{changes:[plan]}])).rows[0];
      return {...plan,change_id:id,preview_hash:hash,expires_at:row.expires_at,notice:plan.notice+" 尚未移动；用户确认后调用 apply_changes。"};
    }
    if(name==="list_note_comments"){
      requireScope(identity,"notes:read");const noteId=identifier(input.note_id),{offset,limit}=page(input);
      const comments=await this.documents.comments(identity.account,noteId,{offset,limit:limit+1,resolved:input.resolved});
      return {note_id:noteId,items:comments.slice(0,limit).map(c=>({id:c.id,parent_id:c.parent_id,author_name:c.author_name,body:c.body,created_at:c.created_at,resolved:c.thread_resolved,anchor:c.anchor,resolved_anchor:c.resolvedAnchor})),next_offset:comments.length>limit?offset+limit:null};
    }
    if(name==="list_folders"){requireScope(identity,"notes:read");return {items:await workspace.folders(identity.account,identifier(input.library_id))};}
    if(name==="search_assets"){
      requireScope(identity,"assets:read");const note=await documentRole(identity.account,identifier(input.note_id)),{offset,limit}=page(input);
      const rows=(await db.query(`SELECT a.* FROM assets a LEFT JOIN documents d ON d.id=a.owner_doc_id WHERE a.space_id=$1 AND NOT a.archived AND (a.owner_doc_id IS NULL OR ${readableDocumentSQL("d","$3","$4")}) AND (a.filename ILIKE '%'||$2||'%' OR a.title ILIKE '%'||$2||'%') ORDER BY a.created_at DESC,a.id LIMIT $5 OFFSET $6`,[note.space_id,String(input.query||"").slice(0,200),identity.account.id,identity.account.is_admin,limit+1,offset])).rows;
      return {items:rows.slice(0,limit).map(assetView),next_offset:rows.length>limit?offset+limit:null};
    }
    if(name==="read_asset")return readAsset(identity,identifier(input.asset_id));
    if(name==="prepare_changes")return this.prepare(identity,input);
    if(name==="apply_changes")return this.apply(identity,input);
    if(name==="begin_upload")return beginUpload(identity,input);
    if(name==="complete_upload")return completeUpload(identity,identifier(input.upload_id));
    if(name==="upload_status")return uploadStatus(identity,identifier(input.upload_id));
    if(name==="cancel_upload")return cancelUpload(identity,identifier(input.upload_id));
    if(name==="import_chatgpt_file")return importChatFile(identity,input);
    fail(404,"没有此 MCP 工具");
  }
}
