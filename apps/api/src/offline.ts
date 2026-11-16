import {Body,Controller,Get,Inject,Param,Post,Req} from "@nestjs/common";
import type {Request} from "express";
import * as Y from "yjs";
import {initProseMirrorDoc} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION,type RichDoc} from "@anote/document-model";
import {stable} from "@anote/sync-core";
import {randomUUID} from "node:crypto";
import fs from "node:fs/promises";
import {Documents} from "./documents.js";
import {db,digest,transaction} from "./database.js";
import {user,documentRole,spaceRole,type User} from "./auth.js";
import {assetFor,assetView,localAssetPath} from "./assets.js";
import {storagePath} from "./storage.js";
import {offlineInventory} from "./offline-inventory.js";
import {identifier,fail,text} from "./errors.js";
import {validateEditorDocument} from "./mcp-model.js";
import {acquireDocument} from "./document-lock.js";
import {requireDocumentStateCapability,requireStateCapability,requireCompatibleDocumentUpdate} from './document-state-policy.js';
import {compactDocumentMigrationValues,scanDocumentMigrationEncoding,validateDocumentMigrationValues} from '@anote/document-model/migration-codec';
import {prepareHistoryState,writeHistoryVersion} from "./history-state-store.js";
import {defaultDocumentEncoding,initializeDocumentEncoding} from './document-state-rollout.js';

const valueOf=(doc:Y.Doc)=>initProseMirrorDoc(doc.getXmlFragment("default"),schema).doc.toJSON() as RichDoc;
function incoming(input:any){
  if(input?.schema!==EDITOR_SCHEMA_VERSION)fail(409,"编辑器格式已更新，请安装新版客户端后同步");
  if(typeof input?.opId!=="string"||!/^[-\w]{10,100}$/.test(input.opId))fail(400,"离线操作 ID 无效");
  const encoded=input?.ystate;
  if(typeof encoded!=="string"||encoded.length>24*1024*1024||encoded.length%4!==0||/[^A-Za-z0-9+/=]/.test(encoded))fail(400,"离线正文格式无效或超过 24 MiB");
  const padding=encoded.indexOf("=");
  // Avoid a repeated-group regular expression: large valid CRDT states can
  // exhaust V8's regexp stack even though their contents are well formed.
  if(padding!==-1&&(padding<encoded.length-2||!/^={1,2}$/.test(encoded.slice(padding))))fail(400,"离线正文 Base64 补位无效");
  const update=Buffer.from(input.ystate,"base64");
  if(!update.length)fail(400,"离线正文为空");
  const document=new Y.Doc();
  try{Y.applyUpdate(document,update);validateEditorDocument(valueOf(document));return document;}
  catch(error){document.destroy();if((error as any).getStatus)throw error;fail(400,"离线正文损坏，已保留客户端副本");}
}
async function assetsOf(account:User,value:RichDoc,space:string){
  const refs=new Map<string,any>();
  const visit=(node:any)=>{if(node.type==="mediaResource")refs.set(identifier(node.attrs?.assetId),node.attrs);if(node.type==="imageComparison")for(const image of node.attrs?.images||[])refs.set(identifier(image.assetId),image);for(const child of node.content||[])visit(child);};
  visit(value);const assets=[];
  for(const [id,attrs] of refs){
    const asset=await assetFor(account,id);if(asset.space_id!==space&&asset.space_id!==null)fail(409,"离线附件不属于当前知识库");if(attrs.localPath!==localAssetPath(asset))fail(409,"离线附件引用已变化");
    let thumbnail;
    const preview=asset.metadata?.thumbnail;
    if(preview&&typeof preview.key==="string"&&typeof preview.hash==="string"&&/^[a-f0-9]{64}$/.test(preview.hash)){
      try{const stat=await fs.lstat(storagePath("derived",preview.key));if(stat.isFile()&&!stat.isSymbolicLink()&&Number.isSafeInteger(stat.size)&&stat.size>0)thumbnail={url:`/api/assets/${id}/thumbnail`,hash:preview.hash,bytes:stat.size,mime:"image/jpeg"};}catch{/* Optional previews must not prevent original-file offline downloads. */}
    }
    assets.push({...assetView(asset),path:localAssetPath(asset),can_edit:false,jobs:[],...(thumbnail?{thumbnail}:{})});
  }
  return assets;
}
export async function offlineSnapshot(documents:Documents,account:User,id:string,capability?:unknown){
  await documentRole(account,id);
  await requireDocumentStateCapability(id,capability);
  return documents.access(id,async document=>{
    await requireDocumentStateCapability(id,capability);
    const role=await documentRole(account,id),row=(await db.query("SELECT id,space_id,folder_id,title,tags,revision,archived,updated_at,visibility,created_by,access_revision,state_encoding,state_revision FROM documents WHERE id=$1",[id])).rows[0];
    const snapshot=valueOf(document);
    return {...row,library_archived:role.library_archived,library_archive_revision:role.library_archive_revision,role:role.role,can_manage:role.role==="admin",snapshot,ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"),schema:EDITOR_SCHEMA_VERSION,assets:await assetsOf(account,snapshot,row.space_id)};
  });
}
export async function syncOffline(documents:Documents,account:User,id:string,input:any,capability:unknown=input?.migrationEncoding){
  const policy=(await db.query('SELECT state_encoding FROM documents WHERE id=$1',[id])).rows[0];
  if(policy){await documentRole(account,id,'edit');requireStateCapability(policy.state_encoding,capability);}
  const creationEncoding=policy?undefined:await defaultDocumentEncoding();
  if(!policy)requireStateCapability(creationEncoding!,capability);
  const {migrationEncoding:_capability,...intent}=input||{},local=incoming(input),payloadHash=digest(stable(intent));
  const acknowledged=async()=>{const row=(await db.query("SELECT doc_id,payload_hash,result FROM offline_operations WHERE actor=$1 AND op_id=$2",[account.id,input.opId])).rows[0];if(!row)return null;if(row.doc_id!==id||row.payload_hash!==payloadHash)fail(409,"操作 ID 已用于不同的离线内容");return row.result;};
  try{
    validateDocumentMigrationValues(local);
    if((policy?.state_encoding??creationEncoding)===1&&scanDocumentMigrationEncoding(local)>1)fail(409,'服务器尚未切换此笔记编码，本地原稿已保留');
    // A duplicate still needs current access, including after deletion/revocation.
    const exists=(await db.query("SELECT id FROM documents WHERE id=$1",[id])).rowCount;
    if(!exists){
      if(!input.create)fail(404,"服务器笔记已不存在，本地副本已保留");
      const release=await acquireDocument(id);
      try{
        const space=identifier(input.create.space_id),folder=input.create.folder_id?identifier(input.create.folder_id):null,title=text(input.title||input.create.title,"笔记标题"),value=valueOf(local);
        await spaceRole(account,space,"create");await assetsOf(account,value,space);
        const encoding=await initializeDocumentEncoding(local);
        const state=Buffer.from(Y.encodeStateAsUpdate(local)),version=randomUUID(),historyState=await prepareHistoryState(state);
        return await transaction(async sql=>{
          await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))",["offline:"+account.id+":"+input.opId]);
          await sql.query("SELECT id FROM spaces WHERE id=$1 FOR KEY SHARE",[space]);
          const role=(await sql.query("SELECT effective_space_role($1,$2) AS role",[account.id,space])).rows[0]?.role;
          if(!["admin","editor","contributor"].includes(role))fail(403,"知识库创建权限已变更");
          if(folder&&!(await sql.query("SELECT id FROM folders WHERE id=$1 AND space_id=$2 FOR KEY SHARE",[folder,space])).rowCount)fail(409,"目标目录已变化");
          const previous=(await sql.query("SELECT doc_id,payload_hash,result FROM offline_operations WHERE actor=$1 AND op_id=$2",[account.id,input.opId])).rows[0];
          if(previous){if(previous.doc_id!==id||previous.payload_hash!==payloadHash)fail(409,"离线操作 ID 冲突");return previous.result;}
          const kind=(await sql.query("SELECT kind FROM spaces WHERE id=$1",[space])).rows[0]?.kind,visibility=input.create.visibility||(kind==="team"?"team":"private");
          if(!["private","team"].includes(visibility)||(kind!=="team"&&visibility!=="private"))fail(400,"笔记可见性无效");
          await sql.query("INSERT INTO documents(id,space_id,folder_id,title,created_by,snapshot,ystate,visibility,last_editor_ids,state_encoding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,ARRAY[$5],$9)",[id,space,folder,title,account.id,value,state,visibility,encoding]);
          await writeHistoryVersion(sql,{id:version,docId:id,snapshot:value,state:historyState,hash:digest(stable(value)),author:account.id,source:'offline',editorIds:[account.id]});
          const result={applied:true,doc_id:id,version_id:version};
          await sql.query("INSERT INTO offline_operations(actor,op_id,doc_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",[account.id,input.opId,id,payloadHash,result]);return result;
        });
      }finally{release();}
    }
    await documentRole(account,id,"edit");
    return await documents.access(id,async document=>{
      await documentRole(account,id,"edit");const encoding=await requireDocumentStateCapability(id,capability),prior=await acknowledged();if(prior)return prior;
      requireCompatibleDocumentUpdate(document,Y.encodeStateAsUpdate(local),encoding);
      const clone=new Y.Doc();
      try{
        Y.applyUpdate(clone,Y.encodeStateAsUpdate(document));Y.applyUpdate(clone,Y.encodeStateAsUpdate(local));
        if(encoding===2)compactDocumentMigrationValues(clone);
        const value=validateEditorDocument(valueOf(clone)),row=(await db.query("SELECT * FROM documents WHERE id=$1",[id])).rows[0],changed=stable(value)!==stable(valueOf(document));
        await assetsOf(account,value,row.space_id);
        const before=changed?valueOf(document):null,beforeHash=before?digest(stable(before)):null,beforeState=changed?await prepareHistoryState(Buffer.from(Y.encodeStateAsUpdate(document))):null;
        // Permission/title checks and the pre-merge history checkpoint share the
        // merge transaction. A rejected submission must leave no history behind.
        const requestedTitle=input.title===undefined?undefined:text(input.title,"笔记标题"),baseTitle=input.baseTitle??input.create?.title;
        if(requestedTitle!==undefined&&typeof baseTitle!=="string")fail(400,"缺少离线标题基线");
        let result:any,titleChanged=false;
        await documents.persist(id,clone,changed?account.id:null,"offline",changed,async sql=>{
          if(titleChanged)await sql.query("UPDATE documents SET title=$2,updated_at=now(),last_editor_ids=ARRAY[$3] WHERE id=$1",[id,requestedTitle,account.id]);
          result={applied:true,doc_id:id};await sql.query("INSERT INTO offline_operations(actor,op_id,doc_id,payload_hash,result) VALUES($1,$2,$3,$4,$5)",[account.id,input.opId,id,payloadHash,result]);
        },async sql=>{
          const current=(await sql.query("SELECT title,archived,deleted_at,effective_document_role($2,id) AS role FROM documents WHERE id=$1 FOR UPDATE",[id,account.id])).rows[0];
          if(!current||current.deleted_at)fail(404,"服务器笔记已删除，本地副本已保留");
          if(current.archived||!["admin","editor"].includes(current.role))fail(403,"笔记编辑权限已变更，本地副本已保留");
          if(requestedTitle!==undefined){if(current.title!==baseTitle&&current.title!==requestedTitle)fail(409,"笔记标题已被其他人修改，本地副本已保留");titleChanged=current.title!==requestedTitle;}
          if(changed&&before&&beforeHash&&beforeState){const latest=(await sql.query("SELECT hash FROM document_versions WHERE doc_id=$1 ORDER BY created_at DESC LIMIT 1",[id])).rows[0];if(latest?.hash!==beforeHash)await writeHistoryVersion(sql,{id:randomUUID(),docId:id,snapshot:before,state:beforeState,hash:beforeHash,source:'before-offline',editorIds:row.pending_editor_ids||[],createdAtOffsetMicros:-1});}
        });
        Y.applyUpdate(document,Y.encodeStateAsUpdate(clone,Y.encodeStateVector(document)),{source:"local",context:{actor:account.id}});return result;
      }finally{clone.destroy();}
    });
  }finally{local.destroy();}
}
@Controller("api")
export class OfflineController {
  constructor(@Inject(Documents) private readonly documents:Documents){}
  @Get("offline/inventory") async inventory(@Req() req:Request){return offlineInventory(await user(req));}
  @Get("documents/:id/offline") async snapshot(@Req() req:Request,@Param("id") id:string){return offlineSnapshot(this.documents,await user(req),identifier(id),req.headers['x-anote-state-encoding']);}
  @Post("documents/:id/offline-sync") async sync(@Req() req:Request,@Param("id") id:string,@Body() input:any){const account=await user(req),key=identifier(id);await syncOffline(this.documents,account,key,input,req.headers['x-anote-state-encoding']??input?.migrationEncoding);return offlineSnapshot(this.documents,account,key,req.headers['x-anote-state-encoding']??input?.migrationEncoding);}
}
