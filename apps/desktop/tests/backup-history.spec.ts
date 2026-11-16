import {test,expect,_electron,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {api,openWorkspaceSettings,switchWorkspace} from '../../web/tests/helpers';
import {person} from '../../web/tests/mcp-helpers';

const origin=process.env.BASE_URL||'http://anote.internal:3000',executable=process.env.DESKTOP_EXECUTABLE;
const artifacts=process.env.ANOTE_TEST_ARTIFACT_ROOT||'artifacts/preview-050/desktop';
const active:ElectronApplication[]=[];
test.afterEach(async()=>{for(const app of active.splice(0))await app.close().catch(()=>{});});
async function settings(page:Page){await openWorkspaceSettings(page);const modal=page.getByRole('dialog',{name:'设置',exact:true});await modal.getByRole('button',{name:'离线与备份',exact:true}).click();await expect(modal.getByRole('button',{name:'立即备份',exact:true})).toBeEnabled();return modal;}
async function cached(page:Page,id:string){return page.evaluate(async value=>{const response=await fetch('/api/documents/'+value);if(!response.ok)throw new Error('Cached note read failed');return response.json();},id);}
async function versions(page:Page){return page.evaluate(()=>window.anote.listBackups!());}

test('真实客户端备份历史分页，取消保留副本，删除后修正页码并能恢复剩余时间点',async({request},testInfo)=>{
  expect(origin).toBe('http://anote.internal:3000');
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(process.env.PREVIEW_PUBLIC_ORIGIN||origin);
  const account=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'分页与删除真实验证'},account),note=await api(request,'POST','documents',{space_id:book.id,title:'备份历史测试稿'},account);
  const target=await api(request,'POST','documents',{space_id:book.id,title:'离线笔记链接目标'},account);
  const root=path.resolve(artifacts,'backup-history-profiles',randomUUID()),profile=path.join(root,'profile'),directory=path.join(root,'backups');
  await fs.mkdir(profile,{recursive:true});await fs.mkdir(directory);await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({serverURL:origin}));
  const app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox','--password-store=basic',...(executable?[]:['apps/desktop']),'--document='+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'}});
  active.push(app);expect(await app.evaluate(({app})=>app.isPackaged)).toBe(!!executable);const page=await app.firstWindow();
  await page.getByRole('button',{name:'连接服务器',exact:true}).click();await page.getByLabel('服务地址',{exact:true}).fill(origin);await page.getByLabel('用户名',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'登录并连接',exact:true}).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await page.evaluate(({id,directory})=>window.anote.configureOffline!({enabled:true,scope:'selected',libraryIds:[id],includeAssets:false,backupDirectory:directory,retention:20,backupIntervalMinutes:0}),{id:book.id,directory});
  await expect.poll(()=>page.evaluate(()=>window.anote.offlineStatus!().then(value=>value.complete&&!value.running&&value.availableDocuments===2)),{timeout:60000}).toBe(true);
  await page.evaluate(()=>window.anote.offline(true));await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>value.offline))).toBe(true);
  const made:string[]=[];
  for(let index=0;index<11;index++){
    const text='备份历史版本 '+index;await page.getByTestId('editor').fill(text);
    await expect.poll(async()=>JSON.stringify((await cached(page,note.id)).snapshot)).toContain(text);
    const result=await page.evaluate(()=>window.anote.createBackup!());expect(result?.skipped).not.toBe(true);made.push(result!.id);
  }
  const before=await versions(page);expect(before).toHaveLength(11);const original=(await cached(page,note.id)).snapshot;
  let modal=await settings(page);const articles=modal.getByLabel('本地备份列表',{exact:true}).locator('article'),pagination=modal.getByRole('navigation',{name:'本地备份分页',exact:true});
  await expect(articles).toHaveCount(10);await expect(pagination).toContainText('共 11 份 · 第 1 / 2 页');await expect(pagination.getByRole('button',{name:'上一页',exact:true})).toBeDisabled();
  await pagination.getByRole('button',{name:'下一页',exact:true}).click();await expect(articles).toHaveCount(1);await expect(pagination).toContainText('第 2 / 2 页');
  const selected=before.at(-1)!.id;expect(selected).toBe(made[0]);await articles.first().getByRole('button',{name:/^删除备份：/}).click();
  let confirmation=page.getByRole('dialog',{name:'删除本地备份',exact:true});await expect(confirmation).toContainText('当前笔记、附件及其他保留备份不受影响');await confirmation.getByRole('button',{name:'取消',exact:true}).click();expect((await versions(page)).map(item=>item.id)).toEqual(before.map(item=>item.id));
  await articles.first().getByRole('button',{name:/^删除备份：/}).click();confirmation=page.getByRole('dialog',{name:'删除本地备份',exact:true});await confirmation.getByRole('button',{name:'删除备份',exact:true}).click();await expect(confirmation).toBeHidden();
  await expect(pagination).toContainText('共 10 份 · 第 1 / 1 页');await expect(articles).toHaveCount(10);await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
  const after=await versions(page);expect(after.map(item=>item.id)).toEqual(before.filter(item=>item.id!==selected).map(item=>item.id));expect((await cached(page,note.id)).snapshot).toEqual(original);
  const backupRoot=path.join(directory,'anote-backups-'+createHash('sha256').update(origin+'|'+account.user.id).digest('hex').slice(0,16));await expect(fs.stat(path.join(backupRoot,selected))).rejects.toMatchObject({code:'ENOENT'});
  await page.screenshot({path:path.join(root,'history-after-delete.png'),fullPage:true});
  await articles.last().getByRole('button',{name:/^恢复备份：/}).click();const restore=page.getByRole('dialog',{name:'恢复本地备份',exact:true});
  await restore.getByRole('button',{name:'保留当前副本并恢复',exact:true}).click();await expect(page.getByTestId('editor')).toHaveText('备份历史版本 1');
  expect((await versions(page)).some(item=>item.id===selected)).toBe(false);
  await page.getByTestId('editor').locator(':scope > p').last().click();await page.keyboard.press('End');await page.keyboard.press('ControlOrMeta+k');
  const picker=page.getByRole('dialog',{name:'插入笔记链接',exact:true});await picker.getByRole('combobox',{name:'搜索可读笔记',exact:true}).fill(target.title);await picker.getByRole('option',{name:new RegExp(target.title)}).click();
  await expect(page.getByRole('region',{name:'参考笔记',exact:true})).toContainText(target.title);
  await app.evaluate(({shell})=>{(globalThis as any).__noteExternalCalls=[];shell.openExternal=async(url:string)=>{(globalThis as any).__noteExternalCalls.push(url);};});
  const beforeServerAuxiliary=await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON());
  await page.getByTestId('editor').getByRole('link',{name:target.title,exact:true}).click({modifiers:['ControlOrMeta']});
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).__noteExternalCalls)).toEqual([origin+'/?doc='+target.id]);
  expect(await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON())).toEqual(beforeServerAuxiliary);
  await app.evaluate(({clipboard})=>clipboard.writeText('PRIMARY must not be inserted into the server note','selection'));
  await page.getByTestId('editor').getByRole('link',{name:target.title,exact:true}).click({button:'middle'});
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).__noteExternalCalls)).toEqual([origin+'/?doc='+target.id,origin+'/?doc='+target.id]);
  expect(await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON())).toEqual(beforeServerAuxiliary);
  await page.getByRole('button',{name:'阅读',exact:true}).click();
  await page.getByTestId('editor').getByRole('link',{name:target.title,exact:true}).click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(target.title);expect((await page.evaluate(()=>window.anote.state())).offline).toBe(true);
  const localDirectory=path.join(root,'local');await fs.mkdir(localDirectory);await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},localDirectory);
  await switchWorkspace(page,'本地模式');await expect.poll(()=>page.evaluate(()=>window.anote.state().then(value=>value.personal))).toBe(true);
  const local=await page.evaluate(async()=>{
    async function create(path:string,data:any){const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!response.ok)throw new Error('Local fixture creation failed');return response.json();}
    const library=await create('spaces',{kind:'personal',name:'纯本地链接验证'}),source=await create('documents',{space_id:library.id,title:'纯本地原稿'}),target=await create('documents',{space_id:library.id,title:'纯本地参考资料'});return {source,target};
  });
  await page.goto('anote://app/?doc='+local.source.id);await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','true');await page.getByTestId('editor').fill('本地笔记也可引用。');await page.keyboard.press('ControlOrMeta+k');
  const localPicker=page.getByRole('dialog',{name:'插入笔记链接',exact:true});await localPicker.getByRole('combobox',{name:'搜索可读笔记',exact:true}).fill(local.target.title);await localPicker.getByRole('option',{name:new RegExp(local.target.title)}).click();
  await expect(page.getByRole('region',{name:'参考笔记',exact:true})).toContainText(local.target.title);
  const beforePersonalAuxiliary=await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON());
  await page.getByTestId('editor').getByRole('link',{name:local.target.title,exact:true}).click({modifiers:['ControlOrMeta']});
  expect(await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON())).toEqual(beforePersonalAuxiliary);
  await app.evaluate(({clipboard})=>clipboard.writeText('PRIMARY must not be inserted into the personal note','selection'));
  await page.getByTestId('editor').getByRole('link',{name:local.target.title,exact:true}).click({button:'middle'});
  expect(await app.evaluate(()=>(globalThis as any).__noteExternalCalls)).toEqual([origin+'/?doc='+target.id,origin+'/?doc='+target.id]);
  expect(await page.getByTestId('editor').evaluate(el=>(el as any).editor.getJSON())).toEqual(beforePersonalAuxiliary);
  await page.getByRole('button',{name:'阅读',exact:true}).click();await page.getByTestId('editor').getByRole('link',{name:local.target.title,exact:true}).click();await expect(page.getByLabel('笔记标题',{exact:true})).toHaveValue(local.target.title);
  const evidence={packaged:!!executable,version:await app.evaluate(({app})=>app.getVersion()),generated:11,perPage:10,cancelKeptAll:true,deleted:selected,remaining:after.map(item=>item.id),currentNotePreservedAfterDelete:true,deletedManifestRemoved:true,pageCorrected:true,remainingSnapshotRestored:true,offlineReferenceNavigation:true,personalReferenceNavigation:true,serverModifiedClickUsesServerOrigin:true,serverMiddleClickUsesServerOrigin:true,personalIDsNotSentExternally:true,auxiliaryClicksPreserveEditorJSON:true,primaryClipboardSeeded:true,finishedAt:new Date().toISOString(),scope:'Real Electron main/preload/renderer with isolated API and independent temporary backup directory'};
  await fs.writeFile(path.resolve(artifacts,'backup-history-native-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await testInfo.attach('backup-history-evidence',{body:Buffer.from(JSON.stringify(evidence,null,2)),contentType:'application/json'});
});
