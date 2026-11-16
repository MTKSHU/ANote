import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,openWorkspaceSettings} from '../../web/tests/helpers';
import {person} from '../../web/tests/mcp-helpers';
import {BackupRepository} from '../main/incremental-backups.mjs';
import {extractFile} from '@electron/asar';
import {stableReleaseSettings} from '../../../validation/scripts/stable-release-settings.mjs';

const origin=process.env.BASE_URL||'http://anote.internal:3000';
const release=stableReleaseSettings(),previousVersion=release.previousVersion,targetVersion=release.version,oldBackupVersion=previousVersion==='0.4.19'?2:3;
const artifactRoot=process.env.ANOTE_TEST_ARTIFACT_ROOT||path.relative(process.cwd(),release.evidenceDirectory);
if(['0.5.1','0.5.2','0.5.3'].includes(targetVersion)&&!path.resolve(artifactRoot).startsWith(release.evidenceDirectory+path.sep)&&path.resolve(artifactRoot)!==release.evidenceDirectory)throw new Error(`${targetVersion} upgrade evidence must not overwrite a previous-release audit`);
const active:ElectronApplication[]=[];
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
test.afterEach(async()=>{for(const app of active.splice(0))await app.close().catch(()=>{});});

async function launch(executable:string,configuration:string,noteId:string){
  const env:NodeJS.ProcessEnv={...process.env,XDG_CONFIG_HOME:configuration,ANOTE_DESKTOP_TEST:'1'};
  // Exercise the production profile resolver, rather than bypassing it with
  // the explicit temporary-directory override used by other native tests.
  delete env.ANOTE_CLIENT_DATA_DIR;
  const app=await _electron.launch({executablePath:path.resolve(executable),args:['--no-sandbox','--password-store=basic','--document='+noteId],env});
  active.push(app);expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true);
  return {app,page:await app.firstWindow()};
}
async function close(app:ElectronApplication){await app.close();active.splice(active.indexOf(app),1);}
async function cached(page:Page,id:string){return page.evaluate(async key=>{const response=await fetch('/api/documents/'+key);if(!response.ok)throw new Error('Offline note read failed: '+response.status);return response.json();},id);}
async function edit(page:Page,tail:string){const update=page.getByRole('complementary',{name:'客户端版本更新',exact:true});if(await update.isVisible())await update.getByRole('button',{name:'稍后',exact:true}).click();await page.getByTestId('editor').locator(':scope > p').last().click();await page.keyboard.press('End');await page.keyboard.insertText(tail);await page.keyboard.press('ControlOrMeta+s');}
async function digestAsset(page:Page,id:string){return page.evaluate(async key=>{const response=await fetch('/api/assets/'+key+'/file');if(!response.ok)throw new Error('Cached attachment read failed: '+response.status);const bytes=await response.arrayBuffer(),sha256=await crypto.subtle.digest('SHA-256',bytes);return {bytes:bytes.byteLength,sha256:[...new Uint8Array(sha256)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};},id);}

test(`正式 ${previousVersion} 升级至 ${targetVersion}：复用 SimpleNote 配置和离线草稿，恢复旧 v${oldBackupVersion} 备份并写入 v3，冷启动不丢稿`,async({request},testInfo)=>{
  const executable=process.env.DESKTOP_EXECUTABLE,oldExecutable=process.env.ANOTE_PREVIOUS_DESKTOP_EXECUTABLE;
  if(!executable||!oldExecutable)throw new Error('Both immutable previous and stable packaged executables are required');
  expect(origin).toBe('http://anote.internal:3000');
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN||origin);
  const startedAt=new Date().toISOString(),account=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'稳定升级隔离资料'},account);
  const note=await api(request,'POST','documents',{space_id:book.id,title:'升级前已存在的正式客户端稿件'},account);
  const attachment=Buffer.from(`ANote ${previousVersion} to ${targetVersion} isolated backup attachment `+randomUUID());
  const upload=await api(request,'POST','uploads',{space_id:book.id,doc_id:note.id,filename:'old-backup.txt',bytes:attachment.length,hash:hash(attachment)},account);
  const sent=await request.put(`/api/uploads/${upload.id}/chunk`,{headers:{Authorization:'Bearer '+account.token,'Content-Type':'application/octet-stream','Upload-Offset':'0','X-Chunk-SHA256':hash(attachment)},data:attachment});expect(sent.ok(),await sent.text()).toBe(true);
  const asset=await api(request,'POST',`uploads/${upload.id}/complete`,{},account);
  const original=previousVersion+' 已保存的原稿 '+randomUUID(),oldTail=' · '+previousVersion+' 关闭前尚未联网的修改 '+randomUUID(),newTail=' · '+targetVersion+' 升级后新增正文 '+randomUUID();
  const doc=prosemirrorJSONToYDoc(schema,{type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:original}]},{type:'mediaResource',attrs:{blockId:randomUUID(),assetId:asset.id,src:asset.url,localPath:`assets/${asset.id}.txt`,title:asset.filename,kind:asset.kind,mime:asset.mime,bytes:asset.bytes,hash:asset.hash,projection:'flat'}},{type:'paragraph',attrs:{blockId:randomUUID()}}]},'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')},account);}finally{doc.destroy();}
  const root=path.resolve(artifactRoot,'stable-upgrade-profiles',randomUUID()),configuration=path.join(root,'config'),profile=path.join(configuration,'SimpleNote'),backups=path.join(root,'backups'),previewProfile=path.join(configuration,'ANote-Preview');
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(backups);await fs.mkdir(previewProfile);
  await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({serverURL:origin}));
  const previewMarker=JSON.stringify({serverURL:'https://preview-profile-must-not-load.invalid',marker:randomUUID()})+'\n';await fs.writeFile(path.join(previewProfile,'settings.json'),previewMarker);
  const oldAsar=path.join(path.dirname(path.resolve(oldExecutable)),'resources/app.asar'),stableAsar=path.join(path.dirname(path.resolve(executable)),'resources/app.asar'),previousHash=hash(await fs.readFile(oldAsar)),stableHash=hash(await fs.readFile(stableAsar));
  const previousHashes:Record<string,string>={'0.4.19':'682832d776189274cd51eb661b55c1ca78668cf295dcc7300d99bc5e0a83a578','0.5.0':'b1220de70414af701479067142e8893db893444d3385d44d93c379f4f02d8adc','0.5.1':'55b83dd0a1c7eb9ce9dc603e8f4920c39f2286267861985b5847342656ff2b69','0.5.2':'78650fbee0c106ac9dd8285e7613970efa249cf1ce252df1cfc6b89dbdc242c8'};
  expect(previousHash).toBe(previousHashes[previousVersion]);
  const packagedWorker=['0.5.1','0.5.2','0.5.3'].includes(targetVersion)?extractFile(stableAsar,'dist/backup-worker.cjs'):null;
  if(packagedWorker){expect(hash(packagedWorker)).toBe(hash(await fs.readFile('apps/desktop/dist/backup-worker.cjs')));expect(extractFile(stableAsar,'dist/main.cjs').toString('utf8')).toContain('backup-worker.cjs');}
  const packagedDocumentWorker=['0.5.2','0.5.3'].includes(targetVersion)?extractFile(stableAsar,'dist/document-worker.cjs'):null;
  if(packagedDocumentWorker){expect(hash(packagedDocumentWorker)).toBe(hash(await fs.readFile('apps/desktop/dist/document-worker.cjs')));expect(extractFile(stableAsar,'dist/main.cjs').toString('utf8')).toContain('document-worker.cjs');}
  let client=await launch(oldExecutable,configuration,note.id),page=client.page;
  expect(await client.app.evaluate(({app})=>app.getVersion())).toBe(previousVersion);expect(await client.app.evaluate(({app})=>app.getPath('userData'))).toBe(profile);
  await page.getByRole('button',{name:'连接服务器',exact:true}).click();await page.getByLabel('服务地址',{exact:true}).fill(origin);await page.getByLabel('用户名',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录并连接',exact:true}).click();await expect(page.getByTestId('editor')).toContainText(original);
  await page.evaluate(({id,backups})=>window.anote.configureOffline!({enabled:true,scope:'selected',libraryIds:[id],includeAssets:true,backupDirectory:backups,backupIntervalMinutes:0,retention:20}),{id:book.id,backups});
  await expect.poll(()=>page.evaluate(async()=>{const value=await window.anote.offlineStatus!();return value.complete&&!value.running&&value.availableDocuments===1&&value.assets===1;}),{timeout:60000}).toBe(true);
  await page.evaluate(()=>window.anote.offline(true));
  expect(await digestAsset(page,asset.id)).toEqual({bytes:attachment.length,sha256:hash(attachment)});
  const first=await page.evaluate(()=>window.anote.createBackup!()),backupRoot=path.join(backups,'anote-backups-'+hash(origin+'|'+account.user.id).slice(0,16));
  const oldManifestFile=path.join(backupRoot,first.id,'manifest.json'),oldManifestBytes=await fs.readFile(oldManifestFile),oldManifest=JSON.parse(oldManifestBytes.toString());
  expect(oldManifest.format).toBe(oldBackupVersion===2?'anote-incremental-backup':'anote-chunked-backup');expect(oldManifest.version).toBe(oldBackupVersion);
  await edit(page,oldTail);await expect.poll(async()=>JSON.stringify((await cached(page,note.id)).snapshot)).toContain(oldTail);
  await close(client.app);
  const oldSettings=JSON.parse(await fs.readFile(path.join(profile,'settings.json'),'utf8'));expect(oldSettings.serverURL).toBe(origin);expect(oldSettings.user.id).toBe(account.user.id);

  client=await launch(executable,configuration,note.id);page=client.page;
  expect(await client.app.evaluate(({app})=>app.getVersion())).toBe(targetVersion);expect(await client.app.evaluate(({app})=>app.getName())).toBe('ANote');expect(await client.app.evaluate(({app})=>app.getPath('userData'))).toBe(profile);
  await expect(page.getByTestId('editor')).toContainText(original);await expect(page.getByTestId('editor')).toContainText(oldTail);
  const retained=await page.evaluate(()=>window.anote.state());expect(retained.serverURL).toBe(origin);expect(retained.user?.id).toBe(account.user.id);expect(retained.offline).toBe(true);
  const config=await page.evaluate(()=>window.anote.offlineStatus!().then(value=>value.config));expect(config.backupDirectory).toBe(backups);expect(config.libraryIds).toEqual([book.id]);expect(config.retention).toBe(20);
  expect(await digestAsset(page,asset.id)).toEqual({bytes:attachment.length,sha256:hash(attachment)});
  expect((await page.evaluate(()=>window.anote.listBackups!())).map(item=>item.id)).toEqual([first.id]);
  await edit(page,newTail);await expect.poll(async()=>JSON.stringify((await cached(page,note.id)).snapshot)).toContain(newTail);
  await openWorkspaceSettings(page);const modal=page.getByRole('dialog',{name:'设置',exact:true});await modal.getByRole('button',{name:'离线与备份',exact:true}).click();
  await modal.getByLabel('本地备份列表',{exact:true}).getByRole('button',{name:/^恢复备份：/}).click();
  const restore=page.getByRole('dialog',{name:'恢复本地备份',exact:true}),reload=page.waitForEvent('domcontentloaded');await restore.getByRole('button',{name:'保留当前副本并恢复',exact:true}).click();await reload;
  await expect(page.getByTestId('editor')).toContainText(original);await expect(page.getByTestId('editor')).not.toContainText(oldTail);await expect(page.getByTestId('editor')).not.toContainText(newTail);
  const records=await page.evaluate(()=>window.anote.listBackups!());expect(records).toHaveLength(2);const preserved=records.find(item=>item.id!==first.id)!;
  const repository=new BackupRepository(backupRoot,{identity:{serverURL:origin,userId:account.user.id},schema:EDITOR_SCHEMA_VERSION}),saved=await repository.read(preserved.id);
  expect(saved.format).toBe('anote-chunked-backup');expect(saved.version).toBe(3);expect(JSON.stringify(saved.data.documents[note.id].snapshot)).toContain(oldTail);expect(JSON.stringify(saved.data.documents[note.id].snapshot)).toContain(newTail);
  const newBackup=await page.evaluate(()=>window.anote.createBackup!());const newManifest=JSON.parse(await fs.readFile(path.join(backupRoot,newBackup.id,'manifest.json'),'utf8'));expect(newManifest.version).toBe(3);expect(newManifest.format).toBe('anote-chunked-backup');
  expect(await fs.readFile(oldManifestFile)).toEqual(oldManifestBytes);expect(await digestAsset(page,asset.id)).toEqual({bytes:attachment.length,sha256:hash(attachment)});
  const finalTail=' · 新版冷启动持久化验证 '+randomUUID();await edit(page,finalTail);await expect.poll(async()=>JSON.stringify((await cached(page,note.id)).snapshot)).toContain(finalTail);await close(client.app);
  client=await launch(executable,configuration,note.id);page=client.page;await expect(page.getByTestId('editor')).toContainText(original);await expect(page.getByTestId('editor')).toContainText(finalTail);await expect(page.getByTestId('editor')).not.toContainText(oldTail);
  expect(await digestAsset(page,asset.id)).toEqual({bytes:attachment.length,sha256:hash(attachment)});expect(await fs.readFile(path.join(previewProfile,'settings.json'),'utf8')).toBe(previewMarker);
  // Electron may create the canonical app-name directory while resolving its
  // initial paths, before our legacy resolver selects SimpleNote. It must not
  // create a second profile or move any settings/data into that empty folder.
  const canonicalDirectoryEntries=await fs.readdir(path.join(configuration,'ANote')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});expect(canonicalDirectoryEntries).toEqual([]);expect(hash(await fs.readFile(oldAsar))).toBe(previousHash);expect(hash(await fs.readFile(stableAsar))).toBe(stableHash);
  await page.screenshot({path:path.join(root,'stable-upgrade-cold-start.png'),fullPage:true});
  const evidence={startedAt,finishedAt:new Date().toISOString(),previousVersion,version:targetVersion,channel:'stable',packaged:true,userData:profile,explicitClientDataDirAbsent:true,legacySimpleNoteReused:true,previewProfileUnchanged:true,canonicalDirectoryEntries,serverAndAccountPreserved:true,offlineDraftPreserved:true,backupPreferencesPreserved:true,oldBackup:{id:first.id,format:oldManifest.format,version:oldManifest.version,sha256:hash(oldManifestBytes),unchangedAfterRestore:true},preservedDraft:{id:preserved.id,version:saved.version,oldAndNewDraftRetained:true},newBackup:{id:newBackup.id,version:newManifest.version},...(packagedWorker?{packagedWorker:{file:'dist/backup-worker.cjs',sha256:hash(packagedWorker),currentStablePayloadMatches:true,actualPackagedOperationsCompleted:['list','capture']}}:{}),...(packagedDocumentWorker?{packagedDocumentWorker:{file:'dist/document-worker.cjs',sha256:hash(packagedDocumentWorker),currentStablePayloadMatches:true,offlineDraftRoundTripCompleted:true}}:{}),restoredAttachment:{bytes:attachment.length,sha256:hash(attachment)},coldStartReadable:true,immutableRuntime:{previous:previousHash,stable:stableHash},scope:`Actual ${previousVersion} and stable ${targetVersion} packaged Electron; temporary XDG profile and synthetic isolated-preview API account only. Linux basic password store deliberately retains cache without a persisted token; macOS native keychain acceptance remains separate.`};
  await fs.writeFile(path.join(artifactRoot,'stable-upgrade-native-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await testInfo.attach('stable-upgrade-evidence',{body:Buffer.from(JSON.stringify(evidence,null,2)),contentType:'application/json'});
});
