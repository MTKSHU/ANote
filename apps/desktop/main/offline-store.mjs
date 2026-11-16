import fs from "node:fs/promises";
import {createReadStream,createWriteStream} from "node:fs";
import path from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import * as Y from "yjs";
import {initProseMirrorDoc,prosemirrorJSONToYDoc,updateYFragment} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {readJSON} from "./session-store.mjs";
import {normalizeSvgAsset} from "./svg-assets.mjs";
import {BackupRepository} from "./incremental-backups.mjs";
import {runBackupWorker} from "./backup-worker-runner.mjs";
import {runDocumentWorker,stateFreeRecord} from "./document-worker-runner.mjs";

const when=()=>new Date().toISOString();
const VALIDATION_RECOVERY_VERSION=1;
const hash=value=>createHash("sha256").update(value).digest("hex");
const id=value=>{if(typeof value!=="string"||!/^[-\w]{1,80}$/.test(value))throw new Error("本地笔记 ID 无效");return value;};
const title=value=>{if(typeof value!=="string"||!value.trim()||value.length>200)throw new Error("笔记标题为空或超过 200 字");return value.trim();};
const encode=doc=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
const snapshot=doc=>initProseMirrorDoc(doc.getXmlFragment("default"),schema).doc.toJSON();
function decode(value){
  if(typeof value!=="string"||value.length>64*1024*1024)throw new Error("本地笔记正文格式无效或超过 64 MiB");
  const doc=new Y.Doc();try{Y.applyUpdate(doc,Buffer.from(value,"base64"));schema.nodeFromJSON(snapshot(doc)).check();return doc;}catch(error){doc.destroy();throw new Error("本地笔记正文损坏："+error.message);}
}
function merge(...values){const doc=new Y.Doc();try{for(const value of values.filter(Boolean))Y.applyUpdate(doc,Buffer.from(value,"base64"));return {ystate:encode(doc),snapshot:snapshot(doc)};}finally{doc.destroy();}}
async function safe(root,relative=""){
  const target=path.resolve(root,relative);if(target!==root&&!target.startsWith(root+path.sep))throw new Error("本地文件路径无效");
  let current=root;
  if((await fs.lstat(root).catch(()=>null))?.isSymbolicLink())throw new Error("本地数据目录不能是符号链接");
  for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){current=path.join(current,part);if((await fs.lstat(current).catch(()=>null))?.isSymbolicLink())throw new Error("本地数据目录不能包含符号链接");}
  return target;
}
async function write(root,relative,value){
  const file=await safe(root,relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+"."+randomUUID()+".tmp",handle=await fs.open(temp,"wx",0o600);
  try{await handle.writeFile(Buffer.isBuffer(value)||typeof value==="string"?value:JSON.stringify(value,null,2)+"\n");await handle.sync();}finally{await handle.close();}
  await safe(root,relative);await fs.rename(temp,file);
}
async function fileHash(file){const digest=createHash("sha256");for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest("hex");}
const defaults=()=>({format:1,libraries:[],availableLibraries:[],downloadedLibraryIds:[],folders:{},catalogs:{},documents:{},inventoryDocuments:{},hasInventory:false,requiredDocumentIds:[],teams:[],platform:{site_name:"ANote"},config:{enabled:false,scope:"all-readable",libraryIds:[],includeAssets:true,backupDirectory:"",retention:10,backupIntervalMinutes:15},lastDownload:null,lastBackup:null,lastPullAttempt:null,lastCacheUpdate:null,cacheComplete:false,pullError:""});
const documentFingerprint=note=>note.offline_revision||hash(JSON.stringify({revision:note.revision,access_revision:note.access_revision,updated_at:note.updated_at,title:note.title,tags:note.tags,folder_id:note.folder_id,role:note.role,archived:note.archived,library_archived:note.library_archived,assets:note.assets?.map(a=>[a.id,a.hash,a.revision,a.metadata])}));
const canCreate=library=>library&&!library.archived&&library.offline_scope!=="documents"&&library.can_create!==false&&["admin","editor","contributor"].includes(library.role);
const recordSignature=stat=>`${stat.ino}:${stat.size}:${stat.mtimeMs}`;
const denied=()=>Response.json({error:"访问权限已变化，此内容不再可用；本地未同步修改已独立保留"},{status:403,headers:{"Cache-Control":"no-store"}});

/** Durable account-scoped offline replicas. Backups are independent directories. */
export class OfflineStore {
  constructor(session,onState=()=>{},{fetch:fetcher=globalThis.fetch,backupWorker,documentWorker}={}){
    this.session=session;this.onState=onState;this.fetcher=fetcher;this.backupWorker=backupWorker;this.documentWorker=documentWorker;this.diskStates=new Set();this.inflightMigrationSources=new Map();this.indexPersisted=false;this.indexDirty=false;this.root=path.resolve(session.dataRoot||session.profileRoot,"offline");this.identity={serverURL:session.settings.serverURL,userId:session.settings.user?.id};this.data=defaults();this.tail=Promise.resolve();this.running=false;this.closed=false;this.lastError="";this.cacheError="";this.networkOnline=true;this.backups=[];this.progress=null;this.abort=new AbortController();this.active=new Set();this.dirtyDocs=new Set();this.pulling=false;this.pullRequested=false;this.nextPullAt=0;this.configurationRevision=0;
  }
  serial(fn){const work=this.tail.catch(()=>{}).then(fn);this.tail=work;return work;}
  assertOpen(){if(this.closed)throw new Error("客户端正在关闭，旧离线副本已停止写入");}
  track(fn){if(this.closed)return Promise.reject(new Error("客户端正在关闭"));const work=Promise.resolve().then(fn);this.active.add(work);void work.finally(()=>this.active.delete(work)).catch(()=>{});return work;}
  async load(){
    await fs.mkdir(this.root,{recursive:true,mode:0o700});await safe(this.root);
    const saved=await readJSON(path.join(this.root,"index.json"),null);
    this.indexPersisted=!!saved;
    if(saved){
      if(saved.identity?.serverURL!==this.identity.serverURL||saved.identity?.userId!==this.identity.userId)throw new Error("离线副本不属于当前账号或服务器");
      this.data={...defaults(),...saved,config:{...defaults().config,...saved.config}};
      if(saved.config?.enabled===undefined){this.data.config.enabled=!!saved.config?.libraryIds?.length;this.data.config.scope=this.data.config.enabled?"selected":"all-readable";if(!this.data.config.enabled)this.data.config.includeAssets=true;}
      if(saved.format===2&&Array.isArray(saved.documents)){
        this.data.documents={};const missing=[];for(const key of saved.documents){
          id(key);const file=await safe(this.root,`documents/${key}.json`),stat=await fs.stat(file),summary=await readJSON(await safe(this.root,`documents/${key}.summary.json`),null);
          const valid=summary?.format==='anote-document-summary'&&summary.source===recordSignature(stat)&&summary.record?.metadata?.id===key&&summary.identity?.serverURL===this.identity.serverURL&&summary.identity?.userId===this.identity.userId;
          if(valid){this.data.documents[key]=summary.record;this.diskStates.add(key);}else missing.push(key);
        }
        // Reuse a worker for an old cache upgrade instead of booting the
        // complete document runtime once for every retained note.
        for(let offset=0;offset<missing.length;offset+=500){
          const inspected=await runDocumentWorker({operation:'inspectMany',sourceRoot:this.root,identity:this.identity,ids:missing.slice(offset,offset+500)},this.documentWorker);
          for(const entry of inspected.records){this.data.documents[entry.id]=entry.record;this.diskStates.add(entry.id);}
        }
        this.data.documents=Object.fromEntries(saved.documents.map(key=>[key,this.data.documents[key]]));
      }else for(const key of Object.keys(this.data.documents))this.dirtyDocs.add(key);
      for(const [key,record] of Object.entries(this.data.documents))if(record.pending&&record.error==="内容块 ID 重复"&&!record.permissionConflict&&record.validationRecoveryVersion!==VALIDATION_RECOVERY_VERSION){record.blocked=false;record.validationPaused=false;record.validationRecoveryVersion=VALIDATION_RECOVERY_VERSION;this.dirtyDocs.add(key);}
      for(const [key,record] of Object.entries(this.data.documents))if(EDITOR_SCHEMA_VERSION===9&&record.inflight?.schema===8&&record.pending&&record.error?.includes("编辑器格式已更新")&&!record.permissionConflict){record.blocked=false;record.error="";this.dirtyDocs.add(key);}
      if(this.dirtyDocs.size)await this.persist();
    }
    this.timer=setInterval(()=>void this.maintenance().catch(error=>{this.lastError=error.message;this.onState();}),15000);this.timer.unref();return this;
  }
  async persist(...changed){
    for(const key of changed)this.dirtyDocs.add(id(key));
    const dirty=[...this.dirtyDocs];for(const key of dirty){
      if(this.diskStates.has(key)){
        const record=this.data.documents[key],inflightCurrentState=!!record.inflight?.ystate&&record.inflight.ystate===record.ystate;
        const thin=stateFreeRecord(record);
        await runDocumentWorker({operation:"write",sourceRoot:this.root,identity:this.identity,id:key,record:thin,inflightCurrentState,inflightPreviousOpId:this.inflightMigrationSources.get(key)},this.documentWorker);
        this.inflightMigrationSources.delete(key);delete record.ystate;if(record.inflight)record.inflight=thin.inflight;
      }else{
        await write(this.root,`documents/${key}.json`,this.data.documents[key]);
        await runDocumentWorker({operation:'inspect',sourceRoot:this.root,identity:this.identity,id:key},this.documentWorker);
      }
    }
    const {documents,...index}=this.data;await write(this.root,"index.json",{...index,format:2,documents:Object.keys(documents),identity:this.identity});
    this.indexPersisted=true;this.indexDirty=false;for(const key of dirty)this.dirtyDocs.delete(key);this.cacheError="";this.onState();
  }
  async hydrateRecord(key){
    const record=this.data.documents[key];
    if(record&&this.diskStates.has(key)&&(typeof record.ystate!=="string"||record.inflight&&!record.inflight.ystate)){
      const saved=await readJSON(await safe(this.root,`documents/${key}.json`),null);
      if(saved?.metadata?.id!==key||typeof saved.ystate!=="string")throw new Error("离线笔记正文文件缺失或损坏");
      record.ystate=saved.ystate;
      if(record.snapshot===undefined)record.snapshot=saved.snapshot;
      if(record.inflight&&!record.inflight.ystate){if(saved.inflight?.opId!==record.inflight.opId)throw new Error("待同步笔记原稿缺失");record.inflight.ystate=saved.inflight.ystate;}
    }
    return record;
  }
  async previewRecord(key){
    const record=this.data.documents[key];if(!record||this.isUnavailable(key))return undefined;
    const file=await safe(this.root,`documents/${key}.json`),stat=await fs.stat(file);let preview=await readJSON(await safe(this.root,`documents/${key}.preview.json`),null);
    if(preview?.format!=='anote-document-preview'||preview.source!==recordSignature(stat)||preview.identity?.serverURL!==this.identity.serverURL||preview.identity?.userId!==this.identity.userId||preview.record?.metadata?.id!==key){
      await runDocumentWorker({operation:'inspect',sourceRoot:this.root,identity:this.identity,id:key},this.documentWorker);preview=await readJSON(await safe(this.root,`documents/${key}.preview.json`),null);
    }
    if(!preview?.snapshot)return undefined;
    return {...record.metadata,snapshot:preview.snapshot,preview_source:record.pending?'local-draft':'local-cache',local_revision:record.pending?.revision||0,state_encoding:record.metadata.state_encoding||1};
  }
  async mergeRecord(key,update,prepare){
    if(!this.indexPersisted||this.indexDirty||this.dirtyDocs.size)await this.persist();
    let proposal;
    try{
      const saved=await runDocumentWorker({operation:"merge",sourceRoot:this.root,identity:this.identity,id:key,update},this.documentWorker,value=>{proposal=prepare(value);return proposal;});
      if(saved.changed){this.data.documents[key]=proposal.record;this.diskStates.add(key);this.dirtyDocs.delete(key);this.indexDirty=true;await this.persist();}
      return saved.changed;
    }catch(error){
      // A worker can exit after atomic rename, before returning its ACK. The
      // durable file is then authoritative, including pending/title flags.
      // Reconcile only this failed note; normal commits never return history.
      if(proposal?.record){
        const saved=await readJSON(await safe(this.root,`documents/${key}.json`),null).catch(()=>null);
        if(saved?.metadata?.id===key&&typeof saved.ystate==="string"){
          this.data.documents[key]=stateFreeRecord(saved);this.diskStates.add(key);this.dirtyDocs.delete(key);this.indexDirty=true;
        }
      }
      throw error;
    }
  }
  status(){
    const docs=Object.values(this.data.documents),available=docs.filter(d=>!this.isUnavailable(d.metadata.id)),assets=[...new Map(available.flatMap(d=>d.assets||[]).map(a=>[a.id+":"+a.hash,a])).values()];
    return {config:structuredClone(this.data.config),enabled:this.data.config.enabled,configured:this.data.config.enabled||this.data.config.libraryIds.length>0,libraries:structuredClone(this.data.availableLibraries),downloadedLibraryIds:[...this.data.downloadedLibraryIds],backups:structuredClone(this.backups),progress:this.progress?{...this.progress}:null,networkOnline:this.networkOnline,automaticOffline:!this.networkOnline,running:this.running,pullState:this.pulling?"running":!this.data.config.enabled?"disabled":this.data.pullError?"error":"idle",complete:!!this.data.cacheComplete,lastPullAttempt:this.data.lastPullAttempt,lastCacheUpdate:this.data.lastCacheUpdate,unavailable:docs.length-available.length,availableDocuments:available.length,assetsTotal:assets.length,assetsMissing:assets.filter(a=>!a.available).length,lastError:this.lastError||this.cacheError||this.data.pullError||docs.find(d=>d.validationPaused)?.error||"",lastDownload:this.data.lastDownload,lastBackup:this.data.lastBackup,documents:available.length,pending:docs.filter(d=>d.pending).length,conflicts:docs.filter(d=>d.blocked).map(d=>d.archiveConflict&&!d.permissionConflict&&!this.isUnavailable(d.metadata.id)?{id:d.metadata.id,title:d.metadata.title,error:d.error,kind:"archive"}:d.permissionConflict||this.isUnavailable(d.metadata.id)?{id:d.metadata.id,title:"访问权限已变化的本地修改",error:"服务器权限或笔记状态已变化，原稿已独立保留",kind:"permission"}:d.validationPaused?{id:d.metadata.id,title:d.metadata.title,error:d.error,kind:"validation"}:{id:d.metadata.id,title:d.metadata.title,error:d.error,kind:"title",baseTitle:d.pending?.baseTitle??d.serverTitle,remoteTitle:d.serverTitle}),assets:assets.filter(a=>a.available).length};
  }
  setNetworkOnline(value){if(this.networkOnline!==!!value){this.networkOnline=!!value;this.onState();}}
  hasPending(key){return !!this.data.documents[key]?.pending;}
  isNewDocument(key){return !!this.data.documents[key]?.metadata.offline_new;}
  pendingTitle(key){return this.data.documents[key]?.pending?.title;}
  observeLibraryArchive(metadata){
    if(typeof metadata.library_archived!=="boolean")return;
    for(const list of [this.data.availableLibraries,this.data.libraries])for(const library of list)if(library.id===metadata.space_id&&Number(metadata.library_archive_revision||0)>=Number(library.archive_revision||0))Object.assign(library,{archived:metadata.library_archived,archive_revision:metadata.library_archive_revision||0,can_create:!metadata.library_archived&&["admin","editor","contributor"].includes(library.role)});
  }
  normalizeMetadata(metadata){const library=this.data.availableLibraries.find(l=>l.id===metadata.space_id);if(library){metadata.library_archived=!!library.archived;metadata.library_archive_revision=library.archive_revision||0;}if(metadata.library_archived){metadata.role="viewer";metadata.can_edit=false;metadata.can_manage=false;}if(library?.offline_scope==="documents"){metadata.folder_id=null;metadata.folder_name=null;metadata.space_name="共享笔记";metadata.space_kind="personal";}return metadata;}
  isUnavailable(key){return !!this.data.documents[key]?.unavailable;}
  allowLegacyDocument(key){return !this.isUnavailable(key)&&(!this.data.hasInventory||Object.hasOwn(this.data.inventoryDocuments,key));}
  isAssetUnavailable(key){const references=Object.values(this.data.documents).filter(d=>(d.assets||[]).some(a=>a.id===key));return references.length>0&&references.every(d=>this.isUnavailable(d.metadata.id));}
  async deniedResponse(request,url){if(!["GET","HEAD","PATCH","POST","PUT"].includes(request.method))return null;const note=/^\/api\/documents\/([-\w]+)(?:\/(?:info|preview))?$/.exec(url.pathname);if(note&&this.isUnavailable(note[1]))return denied();const asset=/^\/api\/assets\/([-\w]+)(?:\/(?:file|thumbnail))?$/.exec(url.pathname);if(asset&&this.isAssetUnavailable(asset[1]))return denied();const library=/^\/api\/spaces\/([-\w]+)(?:\/(?:folders|catalog))?$/.exec(url.pathname);if(library&&this.data.hasInventory&&!this.data.availableLibraries.some(l=>l.id===library[1]))return denied();return null;}
  async preservePrivate(key,record,message){await this.hydrateRecord(key);const file=record.privateBackupFile||`private-backups/${key}-${Date.now()}-${randomUUID()}.json`;await write(this.root,file,{identity:this.identity,reason:message,at:when(),document:structuredClone(record)});record.privateBackupFile=file;}
  async holdArchivedDraft(key,record){
    if(!record?.pending||record.archiveConflict)return;
    await this.preservePrivate(key,record,"知识库已归档，未同步修改已独立保留");
    record.archiveConflict=true;record.blocked=true;record.validationPaused=false;record.error="知识库已归档，本地修改已保留；恢复知识库后可合并并继续同步";
    record.metadata.role="viewer";record.metadata.can_manage=false;this.dirtyDocs.add(key);
  }
  async denyRecord(key,message){const current=this.data.documents[key];if(!current||current.unavailable)return false;await this.preservePrivate(key,current,message);if(!current.blocked)await write(this.root,`conflicts/${key}-${Date.now()}-${randomUUID()}.json`,{identity:this.identity,reason:message,at:when(),document:structuredClone(current)});current.unavailable=true;current.permissionConflict=true;current.validationPaused=false;current.blocked=true;current.error="访问权限已变化，本地修改已独立保留";current.metadata.role="viewer";current.metadata.can_manage=false;this.dirtyDocs.add(key);return true;}
  async denyDocument(key,status=403,message="服务器权限或笔记状态已变化，本地副本已保留"){
    this.assertOpen();
    if(![403,404].includes(status))return false;
    return this.serial(async()=>{id(key);const changed=await this.denyRecord(key,message);if(changed)await this.persist();return changed;});
  }
  async observe(url,value){
    this.assertOpen();
    if(!(url instanceof URL))url=new URL(url,"anote://app");
    const pathname=url.pathname,note=/^\/api\/documents\/([-\w]+)(?:\/offline)?$/.exec(pathname);
    if(note&&value?.ystate)return this.ingest(value);
    return this.serial(async()=>{
      let changed=true;
      if(pathname==="/api/spaces"&&Array.isArray(value)){
        const before=JSON.stringify([this.data.availableLibraries,this.data.libraries]);changed=false;
        if(this.data.hasInventory){
          for(const list of [this.data.availableLibraries,this.data.libraries])for(const library of list){const live=value.find(item=>item.id===library.id);if(live)Object.assign(library,{archived:!!live.archived,archive_revision:live.archive_revision||0,archived_at:live.archived_at,can_create:!live.archived&&["admin","editor","contributor"].includes(live.role)});}
        }else{this.data.availableLibraries=structuredClone(value);this.data.libraries=structuredClone(value);}
        for(const [key,record] of Object.entries(this.data.documents)){const prior=JSON.stringify(record.metadata),blocked=record.blocked;this.normalizeMetadata(record.metadata);if(record.metadata.library_archived)await this.holdArchivedDraft(key,record);if(prior!==JSON.stringify(record.metadata)||blocked!==record.blocked){this.dirtyDocs.add(key);changed=true;}}
        changed=changed||before!==JSON.stringify([this.data.availableLibraries,this.data.libraries]);
      }
      else if(pathname==="/api/teams"&&Array.isArray(value)){if(this.data.hasInventory)return false;this.data.teams=structuredClone(value);}
      else if(pathname==="/api/platform/public")this.data.platform=structuredClone(value);
      else if(note){this.observeLibraryArchive(value);const record=this.data.documents[note[1]];if(record&&!this.isUnavailable(note[1])){record.metadata=this.normalizeMetadata({...record.metadata,...value,...(record.pending?.title!==undefined?{title:record.pending.title}:{})});delete record.metadata.snapshot;delete record.metadata.ystate;delete record.metadata.assets;record.serverTitle=value.title??record.serverTitle;if(record.blocked&&!record.validationPaused){record.metadata.role="viewer";record.metadata.can_manage=false;}}else changed=false;}
      else {const library=/^\/api\/spaces\/([-\w]+)\/(folders|catalog)$/.exec(pathname);if(library){if(this.data.hasInventory)return false;if(library[2]==="folders")this.data.folders[library[1]]=structuredClone(value);else this.data.catalogs[library[1]]=structuredClone(value);}else changed=false;}
      if(changed)await this.persist(...(note?[note[1]]:[]));return changed;
    });
  }
  observeBackground(url,value){
    // Queue while still open, then track the accepted work through close.
    // A server-authorized response need not wait for this replica's fsync.
    this.assertOpen();const task=this.observe(url,value);this.active.add(task);
    void task.finally(()=>this.active.delete(task)).catch(()=>{});
    void task.catch(error=>{this.cacheError="本地副本更新失败："+error.message;if(!this.closed)this.onState();});
    return task;
  }
  resolveConflict(key,choice){return this.track(()=>this.resolveConflictNow(key,choice));}
  async resolveConflictNow(key,choice){
    id(key);if(!["local-title","remote-title"].includes(choice))throw new Error("请选择保留本地标题或服务器标题");
    const draft=this.data.documents[key];
    if(draft?.archiveConflict&&draft.pending?.create){
      const libraries=await this.api("spaces"),library=libraries.find(item=>item.id===draft.metadata.space_id);
      if(!canCreate(library))throw new Error("知识库仍已归档或创建权限已变化，请先恢复知识库");
      return this.serial(async()=>{
        const current=await this.hydrateRecord(key);if(!current?.pending?.create)throw new Error("草稿状态已变化，请刷新后重试");
        await write(this.root,`conflicts/archive-resume-${key}-${randomUUID()}.json`,{identity:this.identity,at:when(),document:structuredClone(current)});
        for(const list of [this.data.availableLibraries,this.data.libraries]){const book=list.find(item=>item.id===library.id);if(book)Object.assign(book,library,{can_create:true});}
        Object.assign(current,{archiveConflict:false,blocked:false,validationPaused:false,permissionConflict:false,unavailable:false,error:""});Object.assign(current.metadata,{role:"admin",can_manage:true,library_archived:false,library_archive_revision:library.archive_revision||0});
        current.pending.opId=randomUUID();current.pending.revision=(current.pending.revision||0)+1;delete current.inflight;await this.persist(key);return this.status();
      });
    }
    const remote=await this.api(`documents/${key}/offline`);
    if(remote.archived||!["admin","editor"].includes(remote.role))throw new Error("当前仍没有编辑权限，已保留本地只读冲突副本");
    return this.serial(async()=>{
      this.observeLibraryArchive(remote);
      const current=await this.hydrateRecord(key);if(!current?.blocked)throw new Error("此笔记没有待处理冲突");
      await write(this.root,`conflicts/${key}-${Date.now()}-${randomUUID()}.json`,{identity:this.identity,reason:"解决冲突前保留",at:when(),document:structuredClone(current)});
      const combined=merge(remote.ystate,current.ystate),selected=choice==="local-title"?current.metadata.title:remote.title;
      current.ystate=combined.ystate;current.snapshot=combined.snapshot;this.diskStates.delete(key);current.metadata=this.normalizeMetadata({...remote,title:selected});
      delete current.metadata.ystate;delete current.metadata.snapshot;delete current.metadata.assets;delete current.inflight;
      current.serverTitle=remote.title;current.archiveConflict=false;current.blocked=false;current.unavailable=false;current.permissionConflict=false;current.error="";this.lastError="";
      current.pending={opId:randomUUID(),revision:(current.pending?.revision||0)+1,title:selected,baseTitle:remote.title};await this.persist(key);return this.status();
    });
  }
  maintenance(){return this.track(()=>this.maintenanceNow());}
  async maintenanceNow(){
    if(this.closed||this.probing)return;this.probing=true;
    try{
      if(!this.session.settings.offline&&this.session.token){
        try{const response=await this.fetcher(this.identity.serverURL+"/api/health",{signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(5000)])});this.setNetworkOnline(response.status<500);}catch{this.setNetworkOnline(false);}
        if(this.networkOnline&&!this.closed){await this.sync({manual:false});if(this.data.config.enabled&&(this.pullRequested||Date.now()>=this.nextPullAt))await this.download({automatic:true}).catch(()=>{});}
      }
      const interval=this.data.config.backupIntervalMinutes;if(!this.closed&&interval>0&&this.data.config.backupDirectory&&Object.keys(this.data.documents).length&&(!this.data.lastBackup||Date.now()-Date.parse(this.data.lastBackup)>=interval*60000))await this.backup();
    }finally{this.probing=false;}
  }
  async configure(input){
    this.assertOpen();let requestPull=false;
    const result=await this.serial(async()=>{
      const previous=JSON.stringify(this.data.config);
      if(input.enabled!==undefined){if(typeof input.enabled!=="boolean")throw new Error("离线副本开关无效");this.data.config.enabled=input.enabled;}
      if(input.scope!==undefined){if(!["all-readable","selected"].includes(input.scope))throw new Error("离线范围无效");this.data.config.scope=input.scope;}
      if(input.libraryIds!==undefined){if(!Array.isArray(input.libraryIds)||input.libraryIds.length>500)throw new Error("请选择有效知识库");this.data.config.libraryIds=[...new Set(input.libraryIds.map(id))];}
      if(input.includeAssets!==undefined)this.data.config.includeAssets=!!input.includeAssets;
      if(input.backupIntervalMinutes!==undefined){if(!Number.isInteger(input.backupIntervalMinutes)||input.backupIntervalMinutes<0||input.backupIntervalMinutes>10080)throw new Error("自动备份间隔应为 0–10080 分钟，0 为关闭");this.data.config.backupIntervalMinutes=input.backupIntervalMinutes;}
      if(input.retention!==undefined){if(!Number.isInteger(input.retention)||input.retention<1||input.retention>100)throw new Error("备份保留数量应为 1–100");this.data.config.retention=input.retention;}
      if(input.backupDirectory!==undefined){if(typeof input.backupDirectory!=="string")throw new Error("备份目录无效");const directory=input.backupDirectory?await fs.realpath(input.backupDirectory):"";if(directory&&(directory===this.root||directory.startsWith(this.root+path.sep)))throw new Error("请将独立备份保存在离线副本目录以外");this.data.config.backupDirectory=directory;}
      if(previous!==JSON.stringify(this.data.config)){this.configurationRevision++;requestPull=this.data.config.enabled;this.pullRequested=requestPull;this.data.cacheComplete=false;}
      if(!this.data.config.enabled&&this.pullAutomatic)this.pullAbort?.abort();
      await this.persist();return this.status();
    });
    if(requestPull&&!this.closed)void this.maintenance().catch(error=>{this.lastError=error.message;this.onState();});return result;
  }
  async api(endpoint,{method="GET",body,asset=false,signal}={}){if(this.closed)throw new Error("客户端正在关闭");if(this.session.settings.serverURL!==this.identity.serverURL||this.session.settings.user?.id!==this.identity.userId)throw new Error("账号或服务器已切换，旧离线副本停止同步");if(this.session.settings.offline)throw new Error("客户端处于离线模式");if(!this.session.token)throw Object.assign(new Error("请重新登录后同步"),{status:401});const response=await this.fetcher(this.identity.serverURL+"/api/"+endpoint,{method,headers:{Authorization:"Bearer "+this.session.token,"X-ANote-State-Encoding":"2",...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([this.abort.signal,...(signal?[signal]:[]),AbortSignal.timeout(asset?300000:15000)])});if(!response.ok){let value;try{value=await response.json();}catch{}throw Object.assign(new Error(value?.error||value?.message||`服务器返回 ${response.status}`),{status:response.status});}return asset?response:response.json();}
  async ingest(remote,{authorized=false,summary}={}){this.assertOpen();return this.serial(async()=>{
    id(remote.id);const current=this.data.documents[remote.id];if(current&&this.isUnavailable(remote.id)&&!authorized)return false;
    this.observeLibraryArchive(remote);
    const library=this.data.availableLibraries.find(l=>l.id===remote.space_id);
    await this.mergeRecord(remote.id,remote.ystate,({snapshot})=>{
      const record={...stateFreeRecord(current),metadata:{...remote,...(current?.pending?.title!==undefined?{title:current.pending.title}:{})},snapshot,assets:remote.assets===undefined?(current?.assets||[]):remote.assets.map(a=>{const old=current?.assets?.find(old=>old.id===a.id&&old.hash===a.hash&&old.available);return {...a,available:!!old,...(old?.file?{file:old.file}:{}),...(old?.thumbnail?.hash===a.thumbnail?.hash&&old?.thumbnail?.available?{thumbnail:{...a.thumbnail,available:true,file:old.thumbnail.file}}:{})};}),serverTitle:remote.title,downloadedAt:when()};
      delete record.metadata.ystate;delete record.metadata.snapshot;delete record.metadata.assets;
      if(library?.offline_scope==="documents"){record.metadata.folder_id=null;record.metadata.space_name=library.name;record.metadata.space_kind=library.kind;record.metadata.folder_name=null;}
      if(authorized){record.unavailable=false;if(!current?.pending){record.blocked=false;record.permissionConflict=false;record.error="";}}
      if(record.blocked&&!record.validationPaused){record.metadata.role="viewer";record.metadata.can_manage=false;}
      if(summary)record.serverFingerprint=documentFingerprint(summary);
      this.data.lastCacheUpdate=when();return {record};
    });return this.data.documents[remote.id];
  });}
  async downloadAsset(asset,{signal,thumbnail=false}={}){id(asset.id);if(!/^[a-f0-9]{64}$/.test(asset.hash)||!Number.isSafeInteger(asset.bytes)||asset.bytes<0)throw new Error("附件清单无效");const relative=`${thumbnail?"thumbnails":"assets"}/${asset.id}-${asset.hash}`,target=await safe(this.root,relative);if((await fs.stat(target).catch(()=>null))?.size===asset.bytes&&await fileHash(target)===asset.hash)return relative;const response=await this.api(`assets/${asset.id}/${thumbnail?"thumbnail":"file"}`,{asset:true,signal});await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const temp=target+"."+randomUUID()+".tmp",digest=createHash("sha256");let bytes=0;try{await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,next){bytes+=chunk.length;if(bytes>asset.bytes)return next(new Error("附件大小超过清单"));digest.update(chunk);next(null,chunk);}}),createWriteStream(temp,{flags:"wx",mode:0o600}),{signal:AbortSignal.any([this.abort.signal,...(signal?[signal]:[])])});if(bytes!==asset.bytes||digest.digest("hex")!==asset.hash)throw new Error("附件下载校验失败："+asset.id);const handle=await fs.open(temp,"r");try{await handle.sync();}finally{await handle.close();}await fs.rename(temp,target);return relative;}finally{await fs.unlink(temp).catch(()=>{});}}
  download(options){return this.track(()=>this.downloadNow(options));}
  async downloadNow({automatic=false}={}){
    if(automatic&&!this.data.config.enabled)return this.status();
    if(this.running)throw new Error("离线副本正在下载或同步");
    this.running=true;this.pulling=true;this.pullAutomatic=automatic;this.pullAbort=new AbortController();const signal=this.pullAbort.signal,configurationRevision=this.configurationRevision;
    this.pullRequested=false;this.lastError="";this.data.pullError="";this.data.lastPullAttempt=when();this.progress={completed:0,total:0,assetsCompleted:0,assetsTotal:0,currentTitle:"正在读取可访问笔记清单"};this.onState();
    try{
      const config=structuredClone(this.data.config),inventory=await this.api("offline/inventory",{signal});
      if(inventory?.schema!==EDITOR_SCHEMA_VERSION||inventory?.complete!==true||!Array.isArray(inventory.libraries)||!Array.isArray(inventory.documents)||!inventory.folders||!inventory.catalogs)throw new Error("服务器离线清单未完整返回，已保留现有副本");
      const libraries=inventory.libraries;for(const library of libraries)id(library.id);for(const note of inventory.documents){id(note.id);id(note.space_id);}
      const chosen=libraries.filter(l=>config.scope==="all-readable"||config.libraryIds.includes(l.id)),notes=inventory.documents.filter(n=>chosen.some(l=>l.id===n.space_id));this.progress.total=notes.length;
      await this.serial(async()=>{
        this.data.availableLibraries=structuredClone(libraries);this.data.libraries=structuredClone(chosen);this.data.inventoryDocuments=Object.fromEntries(inventory.documents.map(n=>[n.id,structuredClone(n)]));this.data.hasInventory=true;this.data.requiredDocumentIds=notes.map(n=>n.id);this.data.folders=structuredClone(inventory.folders);this.data.catalogs=structuredClone(inventory.catalogs);this.data.teams=structuredClone(inventory.teams||[]);this.data.platform=structuredClone(inventory.platform||this.data.platform);
        for(const [key,record] of Object.entries(this.data.documents)){
          const library=libraries.find(l=>l.id===record.metadata.space_id),localCreate=record.pending?.create&&library&&(canCreate(library)||library.archived);
          if(!Object.hasOwn(this.data.inventoryDocuments,key)&&!localCreate)await this.denyRecord(key,"服务器笔记已删除或访问权限已变化");
          else{const prior=JSON.stringify(record.metadata);this.normalizeMetadata(record.metadata);if(library?.archived)await this.holdArchivedDraft(key,record);if(prior!==JSON.stringify(record.metadata))this.dirtyDocs.add(key);}
        }
        this.data.cacheComplete=notes.every(n=>{const current=this.data.documents[n.id];return current&&!this.isUnavailable(n.id)&&current.serverFingerprint===documentFingerprint(n)&&(!config.includeAssets||(current.assets||[]).every(a=>a.available));});
        await this.persist();
      });
      for(const note of notes){
        if(this.closed||signal.aborted||configurationRevision!==this.configurationRevision)throw new Error("离线副本设置已变化，当前下载已停止");
        this.progress.currentTitle=note.title;this.onState();
        let current=this.data.documents[note.id];
        if(!current||this.isUnavailable(note.id)||current.serverFingerprint!==documentFingerprint(note)){
          try{const remote=await this.api(`documents/${note.id}/offline`,{signal});current=await this.ingest(remote,{authorized:true,summary:note});}
          catch(error){if([403,404].includes(error.status)){this.progress.currentTitle="访问权限已变化";await this.denyDocument(note.id,error.status);this.data.cacheComplete=false;continue;}throw error;}
        }
        if(config.includeAssets){
          this.progress.assetsTotal+=(current.assets||[]).length;
          for(const asset of current.assets||[]){
            const original=asset.file?await fs.stat(await safe(this.root,asset.file)).catch(()=>null):null;
            if(!asset.available||!original||original.size!==asset.bytes){
              if(asset.available)await this.serial(async()=>{asset.available=false;await this.persist(note.id);});
              const relative=await this.downloadAsset(asset,{signal});await this.serial(async()=>{const local=this.data.documents[note.id]?.assets?.find(a=>a.id===asset.id&&a.hash===asset.hash);if(local){local.available=true;local.file=relative;this.data.lastCacheUpdate=when();await this.persist(note.id);}});
            }
            if(asset.thumbnail&&!asset.thumbnail.available&&!asset.thumbnail.unavailable){try{const relative=await this.downloadAsset({...asset.thumbnail,id:asset.id},{signal,thumbnail:true});await this.serial(async()=>{asset.thumbnail={...asset.thumbnail,available:true,file:relative};await this.persist(note.id);});}catch(error){if(error.status!==404)throw error;await this.serial(async()=>{asset.thumbnail.unavailable=true;await this.persist(note.id);});}}
            this.progress.assetsCompleted++;this.onState();
          }
        }
        this.progress.completed++;this.onState();
      }
      await this.serial(async()=>{this.data.cacheComplete=notes.every(n=>{const record=this.data.documents[n.id];return record&&!this.isUnavailable(n.id)&&record.serverFingerprint===documentFingerprint(n)&&(!config.includeAssets||(record.assets||[]).every(a=>a.available));});if(this.data.cacheComplete){this.data.lastDownload=when();this.data.downloadedLibraryIds=chosen.map(l=>l.id);}this.data.pullError=this.data.cacheComplete?"":"部分笔记当前不可用，稍后将重新检查";await this.persist();});this.nextPullAt=Date.now()+60000;return this.status();
    }catch(error){this.lastError=error.message;this.data.pullError=error.message;this.data.cacheComplete=false;this.nextPullAt=Date.now()+15000;if(!this.closed)await this.serial(()=>this.persist());throw error;}
    finally{this.running=false;this.pulling=false;this.pullAutomatic=false;this.pullAbort=null;this.progress=null;this.onState();}
  }
  async cacheDocument(input){this.assertOpen();return this.serial(async()=>{
    const key=id(input.id),existing=this.data.documents[key];if(!existing&&!input.metadata)return false;
    const incomingMetadata=input.metadata?structuredClone(input.metadata):{},previousMetadata=existing?JSON.stringify(existing.metadata):"";
    delete incomingMetadata.ystate;delete incomingMetadata.snapshot;delete incomingMetadata.assets;
    const metadata={...existing?.metadata,...incomingMetadata,...(existing?.pending?.title!==undefined?{title:existing.pending.title}:{})};
    delete metadata.ystate;delete metadata.snapshot;delete metadata.assets;
    return this.mergeRecord(key,input.ystate,({stateChanged,snapshot})=>{
      const record={...(stateFreeRecord(existing)||{assets:[],serverTitle:metadata.title}),metadata:this.normalizeMetadata(metadata),snapshot};
      if(existing&&!record.pending?.title&&incomingMetadata.title!==undefined)record.serverTitle=incomingMetadata.title;
      const localChange=input.local!==false;
      if(stateChanged&&localChange&&record.validationPaused){record.validationPaused=false;record.blocked=false;delete record.inflight;}
      if(record.blocked&&!record.validationPaused){record.metadata.role="viewer";record.metadata.can_manage=false;}
      if(!stateChanged&&previousMetadata===JSON.stringify(record.metadata))return {skip:true};
      record.localUpdatedAt=when();
      if(stateChanged&&localChange&&!record.blocked)record.pending={...record.pending,opId:randomUUID(),revision:(record.pending?.revision||0)+1};
      let privateCopy;
      if(this.isUnavailable(key)){
        record.unavailable=true;record.permissionConflict=true;record.blocked=true;
        record.privateBackupFile=record.privateBackupFile||`private-backups/${key}-${Date.now()}-${randomUUID()}.json`;
        privateCopy={file:record.privateBackupFile,reason:"权限变化前后的本地编辑已独立保留"};
      }
      if(record.metadata.library_archived&&record.pending){record.archiveConflict=true;record.blocked=true;record.error="知识库已归档，本地修改已保留；恢复知识库后可合并并继续同步";record.privateBackupFile=record.privateBackupFile||`private-backups/${key}-${Date.now()}-${randomUUID()}.json`;privateCopy={file:record.privateBackupFile,reason:record.error};}
      return {record,privateCopy};
    });
  });}
  async queueTitle(key,value){this.assertOpen();return this.serial(async()=>{
    const record=this.data.documents[id(key)];if(!record)throw new Error("请先下载此笔记的离线副本");if(record.metadata.library_archived||this.data.availableLibraries.find(l=>l.id===record.metadata.space_id)?.archived)throw new Error("知识库已归档，只能阅读");if(record.blocked&&!record.validationPaused)throw new Error("此笔记有待处理的权限或同步冲突");if(record.validationPaused){record.validationPaused=false;record.blocked=false;delete record.inflight;}
    value=title(value);record.pending={...record.pending,opId:randomUUID(),revision:(record.pending?.revision||0)+1,title:value,baseTitle:record.pending?.baseTitle??record.serverTitle};record.metadata.title=value;record.localUpdatedAt=when();
    await this.persist(key);const saved=await this.hydrateRecord(key);return {...saved.metadata,snapshot:saved.snapshot,ystate:saved.ystate};
  });}
  async createDocument(input){this.assertOpen();return this.serial(async()=>{
    const library=this.data.availableLibraries.find(l=>l.id===input.space_id)||this.data.libraries.find(l=>l.id===input.space_id);
    if(!canCreate(library))throw new Error("请先下载有创建权限的知识库");
    const key=randomUUID(),value={type:"doc",content:[{type:"paragraph",attrs:{blockId:randomUUID()}}]},doc=prosemirrorJSONToYDoc(schema,value,"default");
    try{
      const metadata={id:key,space_id:library.id,folder_id:input.folder_id||null,title:title(input.title||"未命名研究笔记"),visibility:input.visibility||(library.kind==="team"?"team":"private"),role:"admin",can_manage:true,created_by:this.identity.userId,tags:[],archived:false,revision:0,updated_at:when(),offline_new:true};
      this.data.documents[key]={metadata,ystate:encode(doc),snapshot:value,assets:[],serverTitle:metadata.title,localUpdatedAt:when(),pending:{opId:randomUUID(),revision:1,create:{space_id:library.id,folder_id:metadata.folder_id,visibility:metadata.visibility,title:metadata.title}}};
      await this.persist(key);return {...metadata,snapshot:value,ystate:encode(doc)};
    }finally{doc.destroy();}
  });}
  sync({manual=true}={}){return this.track(()=>this.syncNow({manual}));}
  async syncNow({manual=false}={}){
    if(this.running||this.closed||this.session.settings.offline)return this.status();this.running=true;this.lastError="";this.onState();
    try{
      if(manual)await this.serial(async()=>{for(const [key,record] of Object.entries(this.data.documents))if(record.pending&&record.validationPaused&&!record.permissionConflict){record.validationPaused=false;record.blocked=false;record.pending.opId=randomUUID();record.pending.revision=(record.pending.revision||0)+1;delete record.inflight;this.dirtyDocs.add(key);}if(this.dirtyDocs.size)await this.persist();});
      for(const key of Object.keys(this.data.documents)){
        if(this.closed)break;
        const captured=await this.serial(async()=>{
          const record=this.data.documents[key];if(!record?.pending||record.blocked||this.isUnavailable(key))return null;
          const complete=await this.hydrateRecord(key),copy=structuredClone(complete),job=copy.pending;
          if(EDITOR_SCHEMA_VERSION===9&&copy.inflight?.schema===8){
            // The rich format change is additive. Keep the original CRDT and
            // title intent, but give the upgraded request a fresh idempotency
            // key: the old key may already have been acknowledged by schema 8.
            const prior=copy.inflight.opId,next=randomUUID();
            copy.inflight={...copy.inflight,schema:EDITOR_SCHEMA_VERSION,opId:next};
            if(job.opId===prior){job.opId=next;complete.pending.opId=next;}
            complete.inflight=copy.inflight;this.inflightMigrationSources.set(key,prior);await this.persist(key);
          }
          if(!copy.inflight){
            copy.inflight={schema:EDITOR_SCHEMA_VERSION,opId:job.opId,ystate:copy.ystate,...(job.title!==undefined?{title:job.title,baseTitle:job.baseTitle}:{}),...(job.create?{create:job.create,title:copy.metadata.title}:{})};
            complete.inflight=copy.inflight;await this.persist(key);
          }
          return copy;
        });
        if(!captured)continue;
        const job=captured.pending,payload=captured.inflight||{schema:EDITOR_SCHEMA_VERSION,opId:job.opId,ystate:captured.ystate,...(job.title!==undefined?{title:job.title,baseTitle:job.baseTitle}:{}),...(job.create?{create:job.create,title:captured.metadata.title}:{})};
        try{
          const remote=await this.api(`documents/${key}/offline-sync`,{method:"POST",body:payload});
          await this.serial(async()=>{
            this.observeLibraryArchive(remote);
            const current=this.data.documents[key],unchanged=current.pending?.opId===payload.opId;
            await this.mergeRecord(key,remote.ystate,({snapshot})=>{
              const next={...stateFreeRecord(current),snapshot,serverTitle:remote.title,metadata:this.normalizeMetadata({...remote,...(!unchanged&&current.pending?.title!==undefined?{title:current.pending.title}:{})}),error:"",validationPaused:false};
              delete next.metadata.ystate;delete next.metadata.snapshot;delete next.metadata.assets;
              next.assets=(remote.assets||[]).map(a=>{const old=current.assets?.find(old=>old.id===a.id&&old.hash===a.hash&&old.available);return {...a,available:!!old,...(old?.file?{file:old.file}:{})};});
              delete next.inflight;if(unchanged)delete next.pending;else if(next.pending){next.pending={...next.pending};delete next.pending.create;if(next.pending.title!==undefined)next.pending.baseTitle=remote.title;}
              return {record:next};
            });
          });
        }catch(error){
          let remoteTitle;
          if(error.status===409&&!this.closed)try{remoteTitle=(await this.api(`documents/${key}/offline`)).title;}catch{}
          await this.serial(async()=>{
            const current=await this.hydrateRecord(key);current.error=error.message;if(remoteTitle!==undefined)current.serverTitle=remoteTitle;
            if([403,404].includes(error.status))await this.denyRecord(key,"服务器不再允许提交此笔记的本地修改");
            else if(error.status===409){if(error.message.includes("知识库已归档")){current.metadata.library_archived=true;await this.holdArchivedDraft(key,current);}await write(this.root,`conflicts/${key}-${Date.now()}-${randomUUID()}.json`,{identity:this.identity,reason:error.message,at:when(),document:structuredClone(current)});current.blocked=true;current.metadata.role="viewer";current.metadata.can_manage=false;}
            else if([400,413,422].includes(error.status)){await write(this.root,`conflicts/validation-${key}-${randomUUID()}.json`,{identity:this.identity,reason:error.message,at:when(),request:payload,document:structuredClone(current)});current.validationPaused=true;current.validationRecoveryVersion=VALIDATION_RECOVERY_VERSION;current.blocked=true;}
            await this.persist(key);
          });
          this.lastError=error.message;if(error.status===401||!error.status||error.status>=500)break;
        }
      }
      return this.status();
    }finally{this.running=false;this.onState();}
  }
  async read(request,url){
    const method=request.method,pathname=url.pathname;
    const rejection=await this.deniedResponse(request,url);if(rejection)return rejection;
    if(method==="POST"&&pathname==="/api/documents")return Response.json(await this.createDocument(await request.json()));
    const note=/^\/api\/documents\/([-\w]+)$/.exec(pathname);
    if(method==="PATCH"&&note){const input=await request.json();if(Object.keys(input).length===1&&input.title!==undefined)return Response.json(await this.queueTitle(note[1],input.title));return null;}
    if(!["GET","HEAD"].includes(method))return null;
    const asset=/^\/api\/assets\/([-\w]+)(?:\/(file|thumbnail))?$/.exec(pathname);if(asset){if(asset[2])return this.readAsset(request,asset[1],asset[2]==="thumbnail");const resource=await this.normalizedAsset(asset[1]);if(!resource)return null;const value=structuredClone(resource);delete value.file;delete value.available;delete value.path;if(value.thumbnail){delete value.thumbnail.file;delete value.thumbnail.available;}return Response.json({...value,kind:value.kind||value.mime?.split("/")[0]||"file",title:value.title||value.filename||"附件",can_edit:false,jobs:[]},{headers:{"X-ANote-Cache":"offline-replica","Cache-Control":"no-store"}});}
    const preview=/^\/api\/documents\/([-\w]+)\/preview$/.exec(pathname);
    if(preview){const value=await this.serial(()=>this.previewRecord(preview[1]));return value?Response.json(value,{headers:{'X-ANote-Cache':'offline-replica','Cache-Control':'no-store'}}):null;}
    const body=await this.serial(async()=>{
      const notes=Object.values(this.data.documents),visible=notes.filter(n=>!this.isUnavailable(n.metadata.id)).map(n=>({...this.normalizeMetadata(structuredClone(n.metadata)),snapshot:n.snapshot}));
      if(pathname==="/api/spaces"){if(this.data.hasInventory)return this.data.availableLibraries;const scope=new Set([...this.data.config.libraryIds,...visible.map(n=>n.space_id)]);return this.data.availableLibraries.length?this.data.availableLibraries.filter(l=>scope.has(l.id)):this.data.libraries;}
      if(pathname==="/api/teams")return this.data.teams;
      if(pathname==="/api/platform/public")return this.data.platform;
      if(pathname.startsWith("/api/trash/"))return [];
      if(pathname==="/api/documents"){
        const q=(url.searchParams.get("q")||"").toLowerCase(),space=url.searchParams.get("space_id"),archived=url.searchParams.get("archived")==="true",selected=visible.filter(n=>!!n.archived===archived&&(!space||n.space_id===space));
        if(!q)return selected;const result=[];
        for(const note of selected){const preview=note.snapshot?note:await this.previewRecord(note.id);if((note.title+JSON.stringify(preview?.snapshot||'')).toLowerCase().includes(q))result.push(note);}return result;
      }
      if(note){const record=await this.hydrateRecord(note[1]);return record?{...this.normalizeMetadata(structuredClone(record.metadata)),snapshot:record.snapshot,ystate:record.ystate,schema:EDITOR_SCHEMA_VERSION}:undefined;}
      const info=/^\/api\/documents\/([-\w]+)\/info$/.exec(pathname);if(info)return this.data.documents[info[1]]?.metadata;
      const library=/^\/api\/spaces\/([-\w]+)\/(folders|catalog)$/.exec(pathname);if(library)return library[2]==="folders"?this.data.folders[library[1]]:this.data.catalogs[library[1]];
      return undefined;
    });return body===undefined?null:Response.json(body,{headers:{"X-ANote-Cache":"offline-replica","Cache-Control":"no-store"}});
  }
  assetDescriptor(key){const references=Object.values(this.data.documents).filter(d=>!this.isUnavailable(d.metadata.id)).flatMap(d=>d.assets||[]).filter(a=>a.id===key).sort((a,b)=>Number(b.revision||0)-Number(a.revision||0));if(!references.length)return null;const value={...references[0]},original=references.find(a=>a.hash===value.hash&&a.available&&a.file);if(original){value.available=true;value.file=original.file;}const thumbnail=references.find(a=>a.thumbnail?.hash===value.thumbnail?.hash&&a.thumbnail?.available&&a.thumbnail?.file);if(thumbnail)value.thumbnail={...value.thumbnail,available:true,file:thumbnail.thumbnail.file};return value;}
  async normalizedAsset(key){const value=this.assetDescriptor(key);return value?.available&&value.file?normalizeSvgAsset(value,await safe(this.root,value.file)):value;}
  async readAsset(request,key,thumbnail=false){
    if(this.isAssetUnavailable(key))return denied();const resource=await this.normalizedAsset(key);
    let asset=thumbnail?resource?.thumbnail:resource;if(thumbnail&&(!asset?.available||!asset.file)){if(resource?.kind==="image"||resource?.mime?.startsWith("image/"))asset=resource;else return Response.json({error:"此附件的缩略图尚未下载"},{status:404});}
    if(!asset?.available||!asset.file)return null;const file=await safe(this.root,asset.file),stat=await fs.stat(file).catch(()=>null);if(!stat||stat.size!==asset.bytes)return null;
    let start=0,end=stat.size-1,status=200;const headers=new Headers({"Content-Type":asset.mime||"application/octet-stream","Accept-Ranges":"bytes","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-ANote-Cache":"offline-replica","Content-Security-Policy":"sandbox; default-src 'none'"});if(request.headers.has("range")){const range=/^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range")||"");if(!range||(!range[1]&&!range[2]))return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});if(!range[1])start=Math.max(0,stat.size-Number(range[2]));else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}if(start>end||start>=stat.size)return new Response(null,{status:416,headers:{"Content-Range":`bytes */${stat.size}`}});status=206;headers.set("Content-Range",`bytes ${start}-${end}/${stat.size}`);}headers.set("Content-Length",String(Math.max(0,end-start+1)));return new Response(request.method==="HEAD"||stat.size===0?null:Readable.toWeb(createReadStream(file,{start,end})),{status,headers});
  }
  async backupRoot(){if(!this.data.config.backupDirectory)throw new Error("请先选择独立备份目录");const directory=await fs.realpath(this.data.config.backupDirectory),root=path.join(directory,"anote-backups-"+hash(this.identity.serverURL+"|"+this.identity.userId).slice(0,16));await safe(directory,path.basename(root));await fs.mkdir(root,{recursive:true,mode:0o700});return root;}
  async backup(){this.assertOpen();return this.serial(()=>this.backupUnlocked());}
  async backupUnlocked({prune=true,repository}={}){
    if(!repository){
      const root=await this.backupRoot();
      // Preserve the serial write barrier while the worker reads a consistent
      // disk snapshot. No full account clone is posted from Electron's main.
      await this.persist();
      try{
        const value=await runBackupWorker({operation:"capture",backupRoot:root,sourceRoot:this.root,identity:this.identity,schema:EDITOR_SCHEMA_VERSION,previousClock:this.backupClock||0,prune,retention:this.data.config.retention},this.backupWorker);
        this.backupClock=value.clock;this.data.lastBackup=value.capturedAt;this.backups=value.backups;
        await this.persist();return value.result;
      }catch(error){if(error.capturedAt){this.data.lastBackup=error.capturedAt;await this.persist();}throw error;}
    }
    const versions=await repository.manifests();
    this.backupClock=Math.max(Date.now(),(this.backupClock||0)+1,...versions.map(version=>Number(version.id.split("-")[0])+1));
    if(!Number.isSafeInteger(this.backupClock))throw new Error("备份版本时间无效，未清理已有备份");
    for(const key of Object.keys(this.data.documents))await this.hydrateRecord(key);
    const result=await repository.capture(this.data,this.root,{version:this.backupClock+"-"+randomUUID(),createdAt:when(),versions});
    this.data.lastBackup=when();await this.persist();
    this.backups=prune?await repository.prune(this.data.config.retention):await repository.manifests();this.onState();return result;
  }
  async listBackupsUnlocked(root){return (await runBackupWorker({operation:"list",backupRoot:root,identity:this.identity,schema:EDITOR_SCHEMA_VERSION},this.backupWorker)).backups;}
  async listBackups(){return this.serial(async()=>{this.backups=await this.listBackupsUnlocked(await this.backupRoot());this.onState();return structuredClone(this.backups);});}
  async deleteBackup(version){
    this.assertOpen();return this.serial(async()=>{
      this.assertOpen();
      const root=await this.backupRoot();
      const value=await runBackupWorker({operation:"remove",backupRoot:root,identity:this.identity,schema:EDITOR_SCHEMA_VERSION,version},this.backupWorker);
      this.backups=value.backups;this.onState();return this.status();
    });
  }
  async restore(version){this.assertOpen();return this.serial(async()=>{
    if(typeof version!=="string"||!/^\d+-[a-f0-9-]{36}$/.test(version))throw new Error("备份版本无效");
    const root=await this.backupRoot(),repository=new BackupRepository(root,{identity:this.identity,schema:EDITOR_SCHEMA_VERSION});return repository.exclusive(async()=>{
    const manifest=await repository.read(version);
    for(const [key,record] of Object.entries(manifest.data.documents||{})){id(key);if(record.metadata?.id!==key)throw new Error("备份笔记清单无效");const doc=decode(record.ystate);doc.destroy();schema.nodeFromJSON(record.snapshot).check();}
    // Do not prune the selected version until its attachments have been copied.
    // The preserved current draft is retained even when retention is one.
    const preserved=await this.backupUnlocked({prune:false,repository});
    await repository.restoreFiles(this.root,manifest.files||[]);
    if(!this.data.hasInventory){this.data.libraries=manifest.data.libraries;this.data.folders=manifest.data.folders;this.data.catalogs=manifest.data.catalogs;}
    for(const [key,saved] of Object.entries(manifest.data.documents||{})){
      const current=await this.hydrateRecord(key),access=current||saved,record=structuredClone(saved),doc=decode(current?.ystate||saved.ystate);delete record.inflight;this.diskStates.delete(key);
      try{const fragment=doc.getXmlFragment("default"),{meta}=initProseMirrorDoc(fragment,schema);doc.transact(()=>updateYFragment(doc,fragment,schema.nodeFromJSON(saved.snapshot),meta));record.ystate=encode(doc);record.snapshot=snapshot(doc);record.serverTitle=current?.serverTitle??saved.serverTitle;record.pending={opId:randomUUID(),revision:(current?.pending?.revision||0)+1,title:saved.metadata.title,baseTitle:record.serverTitle,...(current?.pending?.create?{create:current.pending.create}:saved.pending?.create?{create:saved.pending.create}:{})};record.localUpdatedAt=when();record.blocked=!!access.blocked&&!access.validationPaused;record.validationPaused=false;record.unavailable=!!access.unavailable;record.permissionConflict=!!access.permissionConflict;this.data.documents[key]=record;this.normalizeMetadata(record.metadata);if(record.metadata.library_archived&&!record.unavailable)await this.holdArchivedDraft(key,record);if(record.unavailable||this.data.hasInventory&&!Object.hasOwn(this.data.inventoryDocuments,key)&&!(record.pending?.create&&canCreate(this.data.availableLibraries.find(l=>l.id===record.metadata.space_id)))){record.unavailable=true;record.permissionConflict=true;record.blocked=true;await this.preservePrivate(key,record,"权限变化后的恢复稿已独立保留");}if(record.blocked){record.metadata.role="viewer";record.metadata.can_manage=false;}this.dirtyDocs.add(key);}finally{doc.destroy();}
    }
    await this.persist();return {restored:version,preserved:preserved.id,documents:Object.keys(manifest.data.documents||{}).length};});
  });}
  async close(){this.closed=true;clearInterval(this.timer);this.abort.abort();await Promise.allSettled([...this.active]);await this.tail.catch(()=>{});if(this.indexDirty)await this.serial(()=>this.persist()).catch(()=>{});}
}
