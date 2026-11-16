import {test,expect,_electron,type ElectronApplication} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {historyHeavyTodo052} from '../../../validation/fixtures/history-heavy-todo-052';
import {api,openWorkspaceSettings} from '../../web/tests/helpers';

test('Electron compact note previews, editing and an unsynced offline draft survive a cold restart',async({request},testInfo)=>{
  const origin=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3190',version=process.env.ANOTE_CLIENT_VERSION||'0.5.4';
  expect(['http://127.0.0.1:3190','http://127.0.0.1:3200']).toContain(origin);expect(['0.5.4','0.5.5']).toContain(version);
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');expect((await api(request,'GET','platform/public')).public_origin).toBe(origin);
  const account=await api(request,'POST','auth/login',{username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD}),book=await api(request,'POST','spaces',{kind:'personal',name:'Native recovery 054'},account),note=await api(request,'POST','documents',{space_id:book.id,title:'独立客户端恢复测试'},account),fixture=historyHeavyTodo052();
  const sql=new Pool({host:'db',user:'anote',database:'anote',password:process.env.DB_PASSWORD});
  try{await sql.query('UPDATE documents SET snapshot=$2,ystate=$3,state_encoding=1 WHERE id=$1',[note.id,fixture.snapshot,Buffer.from(fixture.update)]);}finally{await sql.end();fixture.document.destroy();}
  const preview=await api(request,'POST',`documents/${note.id}/state-maintenance/preview`,{},account),compacted=await api(request,'POST',`documents/${note.id}/state-maintenance/apply`,{confirm:true,sourceStateRevision:preview.sourceStateRevision},account);expect(compacted.applied).toBe(true);
  const legacy=await request.get(`/api/documents/${note.id}/offline`,{headers:{Authorization:'Bearer '+account.token}});expect(legacy.status()).toBe(409);
  const output=process.env.ANOTE_RELEASE_TEST_OUTPUT||'artifacts/repair-054',profile=path.resolve(output,'native-profile-'+randomUUID());await fs.mkdir(profile,{recursive:true});
  let app:ElectronApplication|undefined;
  const launch=async()=>{const executable=process.env.DESKTOP_EXECUTABLE;app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox','--password-store=basic',...(executable?[]:['apps/desktop']),'--document='+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'}});if(executable)expect(await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}))).toEqual({packaged:true,version});return app.firstWindow();};
  try{
    let page=await launch();await page.getByRole('button',{name:'连接服务器',exact:true}).click();await page.getByLabel('服务地址',{exact:true}).fill(process.env.BASE_URL!);await page.getByLabel('用户名',{exact:true}).fill(process.env.ADMIN_USERNAME!);await page.getByLabel('密码',{exact:true}).fill(process.env.ADMIN_PASSWORD!);await page.getByRole('button',{name:'登录并连接',exact:true}).click();
    const editor=page.getByTestId('editor');await expect(editor).toHaveAttribute('contenteditable','true');await expect(editor.locator('input[type="checkbox"]')).toHaveCount(102);
    await expect(page.getByTestId('document-sync')).toContainText(/已同步|已保存/);
    await page.evaluate(()=>window.anote.offline(true));
    const target=editor.locator(`p[data-block-id="${fixture.targetBlockId}"]`),suffix=' 离线追加并保留 '+randomUUID();await target.click();await page.keyboard.press('End');await page.keyboard.insertText(suffix);await page.keyboard.press('ControlOrMeta+s');await expect(target).toContainText(suffix);
    await app!.close();app=undefined;page=await launch();const reopened=page.getByTestId('editor');await expect(reopened).toHaveAttribute('contenteditable','true');await expect(reopened.locator(`p[data-block-id="${fixture.targetBlockId}"]`)).toContainText(suffix);
    const local=await page.evaluate(async id=>{const response=await fetch('/api/documents/'+id+'/preview');return {status:response.status,body:await response.json()};},note.id);expect(local.status).toBe(200);expect(local.body.preview_source).toBe('local-draft');expect(JSON.stringify(local.body.snapshot)).toContain(suffix);expect(local.body.ystate).toBeUndefined();
    const resumed=await page.evaluate(()=>window.anote.state());
    // Docker has no secure OS keyring. Exercise the real reconnect form when
    // credentials intentionally were not retained, while keeping the draft.
    if(!resumed.token){const settings=await openWorkspaceSettings(page);await settings.getByRole('button',{name:'切换服务器',exact:true}).click();await page.getByLabel('用户名',{exact:true}).fill(process.env.ADMIN_USERNAME!);await page.getByLabel('密码',{exact:true}).fill(process.env.ADMIN_PASSWORD!);await page.getByRole('button',{name:'登录并连接',exact:true}).click();}
    else await page.evaluate(()=>window.anote.offline(false));
    await expect.poll(async()=>JSON.stringify((await api(request,'GET',`documents/${note.id}`,undefined,account)).snapshot).includes(suffix),{timeout:60000}).toBe(true);
    await expect.poll(()=>page.evaluate(()=>{const provider=window.__anoteTest?.provider;return !!provider?.isSynced&&!provider.hasUnsyncedChanges;})).toBe(true);
    await page.screenshot({path:path.join(output,'native-recovered.png'),animations:'disabled'});await testInfo.attach('native-recovery.json',{body:JSON.stringify({beforeBytes:preview.beforeBytes,afterBytes:preview.afterBytes,offlinePendingRecovered:true,serverReceivedAfterReconnect:true,profile,scope:'Docker Linux Electron; macOS M1 not measured'}),contentType:'application/json'});
  }finally{await app?.close().catch(()=>{});}
});
