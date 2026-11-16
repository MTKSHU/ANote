import {test,expect,_electron} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

test('预览包清洁首启使用 ANote-Preview，已有正式名称配置不被载入或修改',async({},testInfo)=>{
  const executable=process.env.DESKTOP_EXECUTABLE;if(!executable)throw new Error('This acceptance test requires a packaged preview executable');
  const root=path.resolve('artifacts/preview-050/desktop/preview-startup',randomUUID()),configuration=path.join(root,'config');
  await fs.mkdir(configuration,{recursive:true});const markers=[];
  for(const name of ['ANote','SimpleNote','ANote']){
    const directory=path.join(configuration,name);await fs.mkdir(directory);
    for(const [file,content] of [['settings.json','{"serverURL":"https://legacy-profile.invalid"}\n'],['personal-mode.json','{"directory":"/legacy-profile-must-not-open"}\n']]){
      const target=path.join(directory,file);await fs.writeFile(target,content);markers.push({file:target,content,sha256:createHash('sha256').update(content).digest('hex')});
    }
  }
  const environment:NodeJS.ProcessEnv={...process.env,XDG_CONFIG_HOME:configuration,ANOTE_DESKTOP_TEST:'1'};delete environment.ANOTE_CLIENT_DATA_DIR;
  const app=await _electron.launch({executablePath:path.resolve(executable),args:['--no-sandbox','--password-store=basic'],env:environment});
  try{
    const page=await app.firstWindow();expect(await app.evaluate(({app})=>app.isPackaged)).toBe(true);
    const userData=await app.evaluate(({app})=>app.getPath('userData'));expect(userData).toBe(path.join(configuration,'ANote-Preview'));
    await expect(page.getByRole('button',{name:'连接服务器',exact:true})).toBeVisible();
    const state=await page.evaluate(()=>window.anote.state());expect(state.user).toBeFalsy();expect(state.personal).not.toBe(true);expect(state.serverURL).toBe('');
    await page.getByRole('button',{name:'连接服务器',exact:true}).click();const address=page.getByLabel('服务地址',{exact:true});await expect(address).toHaveValue(process.env.PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3150');
    for(const marker of markers)expect(await fs.readFile(marker.file,'utf8')).toBe(marker.content);
    await page.screenshot({path:path.join(root,'preview-clean-startup.png')});
    const evidence={version:await app.evaluate(({app})=>app.getVersion()),packaged:true,userData,expectedPreviewDirectory:true,loggedIn:false,anonymousServerURL:state.serverURL,formServerURL:await address.inputValue(),legacyMarkersUnchanged:markers.map(({file,sha256})=>({file,sha256})),explicitClientDataDirAbsent:true,finishedAt:new Date().toISOString(),scope:'Temporary XDG_CONFIG_HOME with synthetic legacy profiles only; no real production profiles mounted'};
    await fs.writeFile('artifacts/preview-050/desktop/preview-startup-evidence.json',JSON.stringify(evidence,null,2)+'\n');await testInfo.attach('preview-startup-evidence',{body:Buffer.from(JSON.stringify(evidence,null,2)),contentType:'application/json'});
  }finally{await app.close();}
});
