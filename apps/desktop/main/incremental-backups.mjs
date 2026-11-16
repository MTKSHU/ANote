import fs from "node:fs/promises";
import {createReadStream,createWriteStream} from "node:fs";
import {pipeline} from "node:stream/promises";
import path from "node:path";
import os from "node:os";
import {createHash,randomUUID} from "node:crypto";
import {backupChunks,MAX_BACKUP_CHUNK} from "./backup-chunks.mjs";

const FORMAT="anote-chunked-backup",VERSION=3;
const isIncremental=manifest=>manifest?.format===FORMAT&&manifest.version===VERSION||manifest?.format==="anote-incremental-backup"&&manifest.version===2;
const VERSION_ID=/^\d+-[a-f0-9-]{36}$/;
const HASH=/^[a-f0-9]{64}$/;
const digest=value=>createHash("sha256").update(value).digest("hex");
export function backupWorkerClaimName(claimId){
  if(typeof claimId!=="string"||!/^[a-f0-9-]{36}$/.test(claimId))throw new Error("备份后台任务标识无效");
  return `${digest(os.hostname()).slice(0,16)}-${process.pid}-${claimId}.lock`;
}
/** Call only after the owning worker has exited, including abnormal exits. */
export async function cleanupBackupWorkerClaim(root,claimId){
  const file=await safe(root,"locks/"+backupWorkerClaimName(claimId));
  await fs.unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;});
}
const compare=(a,b)=>a<b?-1:a>b?1:0;
const versionTime=value=>{const time=Number(value.split("-")[0]);return Number.isSafeInteger(time)&&time>=0?time:null;};
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>compare(a,b))):item);
async function safe(root,relative=""){
  if(typeof relative!=="string"||path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>part===".."))throw new Error("备份文件路径无效");
  const target=path.resolve(root,relative);if(target!==root&&!target.startsWith(root+path.sep))throw new Error("备份文件路径无效");
  let current=root;if((await fs.lstat(current).catch(()=>null))?.isSymbolicLink())throw new Error("备份目录不能包含符号链接");
  for(const part of path.relative(root,target).split(path.sep).filter(Boolean)){current=path.join(current,part);if((await fs.lstat(current).catch(()=>null))?.isSymbolicLink())throw new Error("备份目录不能包含符号链接");}
  return target;
}
async function checksum(file){const hash=createHash("sha256");for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest("hex");}
async function syncDirectory(directory){let handle;try{handle=await fs.open(directory,"r");await handle.sync();}catch(error){if(!["EINVAL","ENOTSUP","EISDIR","EPERM","EACCES","EBADF"].includes(error.code))throw error;}finally{await handle?.close();}}
async function json(file){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch(error){if(error.code==="ENOENT"||error instanceof SyntaxError)return null;throw error;}}
function descriptor(value){if(!value||!HASH.test(value.hash)||!Number.isSafeInteger(value.bytes)||value.bytes<0)throw new Error("备份内容清单无效或损坏");return value;}
function fieldChunks(value,encoding){
  descriptor(value);if(value.encoding!==encoding||!Array.isArray(value.chunks)||value.chunks.length>Math.max(1,value.bytes))throw new Error("备份字段清单无效或损坏");
  let bytes=0;for(const chunk of value.chunks){descriptor(chunk);if(chunk.bytes<1||chunk.bytes>MAX_BACKUP_CHUNK)throw new Error("备份分块大小无效或损坏");bytes+=chunk.bytes;if(!Number.isSafeInteger(bytes)||bytes>value.bytes)throw new Error("备份字段长度无效或损坏");}
  if(bytes!==value.bytes)throw new Error("备份字段长度无效或损坏");return value.chunks;
}
function validAssetPath(value){return typeof value==="string"&&/^(?:assets|thumbnails)\/[-\w.]{1,200}$/.test(value)&&![".",".."].includes(path.posix.basename(value));}
function snapshotData(data){
  const copy=structuredClone(data),documents=copy.documents;delete copy.documents;
  // Runtime checks and backup preferences do not change the saved content.
  for(const key of ["config","lastBackup","lastPullAttempt","lastCacheUpdate","lastDownload","pullError","cacheComplete"])delete copy[key];
  for(const record of Object.values(documents)){
    delete record.downloadedAt;delete record.inflight;
    // Older caches may retain a second full response inside metadata. Only
    // the canonical record fields belong in the body pool.
    if(record.metadata){delete record.metadata.ystate;delete record.metadata.snapshot;delete record.metadata.assets;}
  }
  return {index:copy,documents};
}
function sameIdentity(value,identity){return value?.serverURL===identity.serverURL&&value?.userId===identity.userId;}

/** Immutable, account-local objects and small independently selectable snapshots.
 * Each version lists all required objects independently. Old clients must not
 * recognize or prune newer-format snapshots.
 */
export class BackupRepository {
  constructor(root,{identity,schema,claimId}){this.root=root;this.identity=identity;this.schema=schema;this.claimId=claimId;if(claimId!==undefined)backupWorkerClaimName(claimId);this.token=null;}
  async exclusive(operation){
    if(this.token)throw new Error("备份目录已有备份或恢复操作正在进行，请稍后重试");
    const host=digest(os.hostname()).slice(0,16),token=backupWorkerClaimName(this.claimId||randomUUID()),directory=await safe(this.root,"locks");
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const lock=await safe(this.root,"locks/"+token),handle=await fs.open(lock,"wx",0o600);
    try{
      await handle.sync();await handle.close();
      // Every contender owns a unique claim before checking competitors. If
      // two contend, either both back off or the later one sees the first.
      // Removing a crashed process's unique name cannot unlink a new lock.
      for(const entry of await fs.readdir(directory,{withFileTypes:true})){
        const owner=/^([a-f0-9]{16})-(\d+)-[a-f0-9-]{36}\.lock$/.exec(entry.name);if(!owner||entry.name===token)continue;
        const other=await safe(this.root,"locks/"+entry.name);let alive=true;
        if(owner[1]===host){try{process.kill(Number(owner[2]),0);}catch(error){if(error.code==="ESRCH")alive=false;}}
        // Never steal a live or foreign-machine claim: slow storage, suspend
        // and a busy event loop must not make an active transaction expire.
        if(alive)throw new Error("备份目录已有备份或恢复操作正在进行，请稍后重试");
        await fs.unlink(other).catch(error=>{if(error.code!=="ENOENT")throw error;});
      }
      this.token=token;
      await this.cleanInterrupted();
      await this.collect();
      return await operation();
    }finally{
      if(this.token===token)this.token=null;await handle.close().catch(()=>{});await fs.unlink(lock).catch(()=>{});
    }
  }
  async assertLock(){if(!this.token||!(await fs.lstat(await safe(this.root,"locks/"+this.token)).catch(()=>null))?.isFile())throw new Error("备份目录锁已变化，操作已停止");}
  objectPath(hash){if(!HASH.test(hash))throw new Error("备份内容校验值无效");return safe(this.root,"objects/"+hash);}
  compatibleSchema(value){return value===this.schema||(this.schema===9&&value===8);}
  async manifests(){
    const result=[];
    for(const entry of await fs.readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!VERSION_ID.test(entry.name)||versionTime(entry.name)===null)continue;
      const manifest=await json(await safe(this.root,entry.name+"/manifest.json"));
      if(!sameIdentity(manifest?.identity,this.identity))continue;
      if(!this.compatibleSchema(manifest?.schema))continue;
      if(manifest?.format==="anote-offline-backup"&&manifest.version===1)result.push({id:entry.name,createdAt:manifest.createdAt,documents:Object.keys(manifest.data?.documents||{}).length,assets:manifest.files?.length||0,incremental:false});
      else if(isIncremental(manifest)&&manifest.fingerprint===digest(stable({index:manifest.index,documents:manifest.documents,files:manifest.files})))result.push({id:entry.name,createdAt:manifest.createdAt,documents:Object.keys(manifest.documents||{}).length,assets:manifest.assets??manifest.files?.filter(file=>file.path?.startsWith("assets/")).length??0,incremental:true,addedBytes:manifest.addedBytes||0,fingerprint:manifest.fingerprint});
    }
    return result.sort((a,b)=>compare(versionTime(b.id),versionTime(a.id))||compare(b.id,a.id));
  }
  async verifyObject(reference){
    descriptor(reference);const file=await this.objectPath(reference.hash),stat=await fs.stat(file).catch(()=>null);
    if(!stat?.isFile()||stat.size!==reference.bytes||await checksum(file)!==reference.hash)throw new Error("备份内容缺失或损坏，恢复未开始");
    return file;
  }
  async readField(reference,encoding){
    const chunks=fieldChunks(reference,encoding),buffers=[],hash=createHash("sha256");let bytes=0;
    for(const chunk of chunks){const buffer=await fs.readFile(await this.verifyObject(chunk));buffers.push(buffer);bytes+=buffer.length;hash.update(buffer);}
    if(bytes!==reference.bytes||hash.digest("hex")!==reference.hash)throw new Error("备份字段缺失或损坏，恢复未开始");
    const buffer=Buffer.concat(buffers,bytes);if(encoding==="base64")return buffer.toString("base64");
    try{return JSON.parse(buffer.toString("utf8"));}catch{throw new Error("备份字段损坏，恢复未开始");}
  }
  async recordEnvelope(reference,key){
    const record=await json(await this.verifyObject(reference));
    if(!record||record.metadata?.id!==key)throw new Error("备份笔记清单无效");
    fieldChunks(record.ystate,"base64");fieldChunks(record.snapshot,"json");return record;
  }
  async read(version){
    if(typeof version!=="string"||!VERSION_ID.test(version)||versionTime(version)===null)throw new Error("备份版本无效");
    const directory=await safe(this.root,version),manifest=await json(await safe(directory,"manifest.json"));
    if(!sameIdentity(manifest?.identity,this.identity)||!this.compatibleSchema(manifest.schema))throw new Error("备份格式、账号或服务器不匹配");
    if(manifest.format==="anote-offline-backup"&&manifest.version===1){
      const files=[];
      for(const file of manifest.files||[]){descriptor(file);if(!validAssetPath(file.path))throw new Error("备份附件路径无效");const source=await safe(directory,file.path),stat=await fs.stat(source).catch(()=>null);if(!stat?.isFile()||stat.size!==file.bytes||await checksum(source)!==file.hash)throw new Error("备份附件缺失或损坏，恢复未开始");files.push({...file,source});}
      return {...manifest,files};
    }
    if(!isIncremental(manifest))throw new Error("备份格式、账号或服务器不匹配");
    const fingerprint=digest(stable({index:manifest.index,documents:manifest.documents,files:manifest.files}));
    if(fingerprint!==manifest.fingerprint)throw new Error("备份清单损坏，恢复未开始");
    const data=await json(await this.verifyObject(manifest.index));if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("备份索引损坏，恢复未开始");
    data.documents={};
    for(const [key,reference] of Object.entries(manifest.documents||{})){
      if(!/^[-\w]{1,80}$/.test(key))throw new Error("备份笔记清单无效");
      let record;
      if(manifest.version===VERSION){record=await this.recordEnvelope(reference,key);record.ystate=await this.readField(record.ystate,"base64");record.snapshot=await this.readField(record.snapshot,"json");}
      else{record=await json(await this.verifyObject(reference));if(!record||record.metadata?.id!==key)throw new Error("备份笔记清单无效");}
      data.documents[key]=record;
    }
    const files=[];
    for(const file of manifest.files||[]){if(!validAssetPath(file.path))throw new Error("备份附件路径无效");files.push({...file,source:await this.verifyObject(file)});}
    return {...manifest,data,files};
  }
  async capture(data,sourceRoot,{version,createdAt,versions:knownVersions}){
    await this.assertLock();
    const stats={addedBytes:0,reusedBytes:0},prepared=snapshotData(data),objects=await safe(this.root,"objects");await fs.mkdir(objects,{recursive:true,mode:0o700});
    const seen=new Set(),legacy=new Map(),versions=knownVersions||await this.manifests();
    // Existing v1 backups are immutable inputs. Hard-linking within this backup
    // filesystem imports an old object without another full attachment copy.
    for(const old of versions.filter(item=>!item.incremental)){
      const manifest=await json(await safe(this.root,old.id+"/manifest.json"));
      for(const file of Array.isArray(manifest?.files)?manifest.files:[]){
        try{descriptor(file);}catch{continue;}
        if(validAssetPath(file.path)&&!legacy.has(file.hash))legacy.set(file.hash,{...file,relative:old.id+"/"+file.path});
      }
    }
    const put=async(reference,{buffer,source}={})=>{
      descriptor(reference);if(seen.has(reference.hash))return reference;seen.add(reference.hash);
      await this.assertLock();const target=await this.objectPath(reference.hash),existing=await fs.stat(target).catch(()=>null);
      if(existing?.isFile()&&existing.size===reference.bytes&&await checksum(target)===reference.hash){stats.reusedBytes+=reference.bytes;return reference;}
      const imported=legacy.get(reference.hash);
      if(!existing&&imported&&imported.bytes===reference.bytes){
        let importedSource;
        try{importedSource=await safe(this.root,imported.relative);}catch(error){if(!/备份(?:目录不能包含符号链接|文件路径无效)/.test(error.message))throw error;}
        let importedStat;
        if(importedSource)try{importedStat=await fs.stat(importedSource);}catch(error){if(error.code!=="ENOENT")throw error;}
        if(importedStat?.isFile()&&importedStat.size===reference.bytes&&await checksum(importedSource)===reference.hash){
          try{await fs.link(importedSource,target);stats.reusedBytes+=reference.bytes;return reference;}
          catch(error){if(!["EXDEV","EPERM","EOPNOTSUPP","ENOTSUP","EMLINK","ENOSYS"].includes(error.code))throw error;}
        }
      }
      const temporary=await safe(this.root,"objects/.write-"+randomUUID()+".tmp");
      try{
        if(buffer)await fs.writeFile(temporary,buffer,{flag:"wx",mode:0o600});
        else await pipeline(createReadStream(source),createWriteStream(temporary,{flags:"wx",mode:0o600}));
        const handle=await fs.open(temporary,"r");try{await handle.sync();}finally{await handle.close();}
        if((await fs.stat(temporary)).size!==reference.bytes||await checksum(temporary)!==reference.hash)throw new Error("备份内容校验失败，备份未完成");
        await this.assertLock();await fs.rename(temporary,target);stats.addedBytes+=reference.bytes;return reference;
      }finally{await fs.unlink(temporary).catch(()=>{});}
    };
    const bufferObject=async value=>{const buffer=Buffer.from(stable(value));return put({hash:digest(buffer),bytes:buffer.length},{buffer});};
    const fieldObject=async(buffer,encoding)=>{
      const chunks=[];for(const bytes of backupChunks(buffer))chunks.push(await put({hash:digest(bytes),bytes:bytes.length},{buffer:bytes}));
      return {encoding,hash:digest(buffer),bytes:buffer.length,chunks};
    };
    const index=await bufferObject(prepared.index),documents={};
    for(const key of Object.keys(prepared.documents).sort()){
      const record=prepared.documents[key],ystate=Buffer.from(record.ystate||"","base64");
      if(typeof record.ystate!=="string"||ystate.toString("base64")!==record.ystate)throw new Error("本地笔记状态无效，备份未完成");
      const value={...record,ystate:await fieldObject(ystate,"base64"),snapshot:await fieldObject(Buffer.from(stable(record.snapshot)),"json")};
      documents[key]=await bufferObject(value);
    }
    const files=[];
    const available=new Map(),originals=new Set();
    for(const record of Object.values(prepared.documents))for(const asset of record.assets||[]){
      if(asset.available&&asset.file)originals.add(asset.file);
      for(const resource of [asset,asset.thumbnail])if(resource?.available&&resource.file){const old=available.get(resource.file);if(old&&(old.hash!==resource.hash||old.bytes!==resource.bytes))throw new Error("本地附件清单不一致，备份未完成");available.set(resource.file,resource);}
    }
    for(const [relative,asset] of [...available].sort(([a],[b])=>compare(a,b))){
      descriptor(asset);if(!validAssetPath(relative))throw new Error("本地附件路径无效");
      const source=await safe(sourceRoot,relative),stat=await fs.stat(source).catch(()=>null);if(!stat?.isFile()||stat.size!==asset.bytes||await checksum(source)!==asset.hash)throw new Error("本地附件校验失败，备份未完成："+(asset.id||relative));
      const reference={path:relative,hash:asset.hash,bytes:asset.bytes};await put(reference,{source});files.push(reference);
    }
    await syncDirectory(objects);
    const content={index,documents,files},fingerprint=digest(stable(content)),previous=versions.find(item=>item.incremental);
    if(previous?.fingerprint===fingerprint)return {id:previous.id,directory:await safe(this.root,previous.id),documents:Object.keys(documents).length,assets:originals.size,incremental:true,skipped:true,...stats};
    if(!VERSION_ID.test(version)||versionTime(version)===null)throw new Error("备份版本无效");
    const staging=await safe(this.root,".pending-"+randomUUID()),directory=await safe(this.root,version);await fs.mkdir(staging,{mode:0o700});let committed=false;
    try{
      const manifest={format:FORMAT,version:VERSION,identity:this.identity,schema:this.schema,createdAt,...content,fingerprint,assets:originals.size,addedBytes:stats.addedBytes};
      let buffer;for(;;){buffer=Buffer.from(stable(manifest)+"\n");if(manifest.addedBytes===stats.addedBytes+buffer.length)break;manifest.addedBytes=stats.addedBytes+buffer.length;}
      const file=await fs.open(path.join(staging,"manifest.json"),"wx",0o600);try{await file.writeFile(buffer);await file.sync();}finally{await file.close();}
      await syncDirectory(staging);await this.assertLock();await fs.rename(staging,directory);committed=true;await syncDirectory(this.root);
      return {id:version,directory,documents:Object.keys(documents).length,assets:originals.size,incremental:true,skipped:false,...stats,addedBytes:stats.addedBytes+buffer.length};
    }finally{if(!committed)await fs.rm(staging,{recursive:true,force:true});}
  }
  async prune(retention){
    await this.assertLock();const versions=await this.manifests();
    for(const old of versions.slice(retention))await fs.rm(await safe(this.root,old.id),{recursive:true,force:true});
    await syncDirectory(this.root);await this.collect();return versions.slice(0,retention);
  }
  async incrementalReferences(manifest){
    if(!isIncremental(manifest)||!manifest.documents||typeof manifest.documents!=="object"||Array.isArray(manifest.documents)||!Array.isArray(manifest.files)||manifest.fingerprint!==digest(stable({index:manifest.index,documents:manifest.documents,files:manifest.files})))throw new Error("备份内容清单无效或损坏");
    const references=[descriptor(manifest.index),...manifest.files.map(descriptor)];
    for(const [key,reference] of Object.entries(manifest.documents)){
      if(!/^[-\w]{1,80}$/.test(key))throw new Error("备份笔记清单无效");references.push(descriptor(reference));
      if(manifest.version===VERSION){const record=await this.recordEnvelope(reference,key);references.push(...fieldChunks(record.ystate,"base64"),...fieldChunks(record.snapshot,"json"));}
    }
    return references;
  }
  async remove(version){
    await this.assertLock();
    if(typeof version!=="string"||!VERSION_ID.test(version)||versionTime(version)===null)throw new Error("备份版本无效");
    const directory=await safe(this.root,version),manifest=await json(await safe(directory,"manifest.json"));
    if(!sameIdentity(manifest?.identity,this.identity)||!this.compatibleSchema(manifest?.schema))throw new Error("备份格式、账号或服务器不匹配，未删除备份");
    const recordMap=value=>value&&typeof value==="object"&&!Array.isArray(value);
    if(manifest.format==="anote-offline-backup"&&manifest.version===1){
      if(!recordMap(manifest.data)||!recordMap(manifest.data.documents)||!Array.isArray(manifest.files))throw new Error("备份内容清单无效或损坏，未删除备份");
      for(const [key,record] of Object.entries(manifest.data.documents))if(!/^[-\w]{1,80}$/.test(key)||record?.metadata?.id!==key)throw new Error("备份笔记清单无效，未删除备份");
    }else if(isIncremental(manifest)){
      await this.incrementalReferences(manifest);
    }else throw new Error("备份格式、账号或服务器不匹配，未删除备份");
    for(const file of manifest.files){descriptor(file);if(!validAssetPath(file.path))throw new Error("备份附件路径无效，未删除备份");}
    // Delete only this account's validated version directory. Objects shared
    // with any remaining version are retained by the conservative collector.
    await this.assertLock();await safe(this.root,version);
    await fs.rm(directory,{recursive:true});await syncDirectory(this.root);await this.collect();
    return version;
  }
  async collect(){
    await this.assertLock();const referenced=new Set();
    for(const entry of await fs.readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!VERSION_ID.test(entry.name))continue;
      const manifest=await json(await safe(this.root,entry.name+"/manifest.json"));
      // Unknown or damaged versions may reference objects we cannot understand.
      // Conservatively leave the pool intact rather than guess during cleanup.
      if(!manifest||!sameIdentity(manifest.identity,this.identity)||!this.compatibleSchema(manifest.schema))return false;
      if(manifest.format==="anote-offline-backup"&&manifest.version===1)continue;
      try{for(const value of await this.incrementalReferences(manifest))referenced.add(value.hash);}catch{return false;}
    }
    const objects=await safe(this.root,"objects");
    const entries=await fs.readdir(objects,{withFileTypes:true}).catch(error=>{if(error.code==="ENOENT")return null;throw error;});if(!entries)return true;
    for(const entry of entries){
      if(entry.isFile()&&HASH.test(entry.name)&&!referenced.has(entry.name))await fs.unlink(await this.objectPath(entry.name));
    }
    await syncDirectory(objects);return true;
  }
  async cleanInterrupted(){
    await this.assertLock();
    // An acquired claim means no other compatible writer can own these known
    // staging names. Unknown files and all committed version directories stay.
    for(const entry of await fs.readdir(this.root,{withFileTypes:true}))if(entry.isDirectory()&&/^\.pending-[a-f0-9-]{36}$/.test(entry.name))await fs.rm(await safe(this.root,entry.name),{recursive:true,force:true});
    const objects=await safe(this.root,"objects");
    for(const entry of await fs.readdir(objects,{withFileTypes:true}).catch(error=>{if(error.code==="ENOENT")return [];throw error;}))if(entry.isFile()&&/^\.write-[a-f0-9-]{36}\.tmp$/.test(entry.name))await fs.unlink(await safe(this.root,"objects/"+entry.name));
  }
  async restoreFiles(targetRoot,files){
    for(const file of files){
      await this.assertLock();if(!validAssetPath(file.path))throw new Error("备份附件路径无效");
      const target=await safe(targetRoot,file.path),existing=await fs.stat(target).catch(()=>null);
      if(existing?.isFile()&&existing.size===file.bytes&&await checksum(target)===file.hash)continue;
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const temporary=target+".restore-"+randomUUID()+".tmp";
      try{
        await pipeline(createReadStream(file.source),createWriteStream(temporary,{flags:"wx",mode:0o600}));
        const handle=await fs.open(temporary,"r");try{await handle.sync();}finally{await handle.close();}
        if((await fs.stat(temporary)).size!==file.bytes||await checksum(temporary)!==file.hash)throw new Error("备份附件缺失或损坏，恢复未开始");
        await safe(targetRoot,file.path);await this.assertLock();await fs.rename(temporary,target);await syncDirectory(path.dirname(target));
      }finally{await fs.unlink(temporary).catch(()=>{});}
    }
  }
}
