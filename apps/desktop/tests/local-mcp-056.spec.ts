import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect,_electron,type ElectronApplication} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PersonalStore} from '../main/personal-store.mjs';
import {openWorkspaceSettings} from '../../web/tests/helpers';

test('real Electron local MCP flushes pending typing, applies CRDT edits, exports full Markdown and stops on workspace exit',async()=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');const version=process.env.DESKTOP_EXPECTED_VERSION||'0.5.6',evidence=process.env.DESKTOP_EVIDENCE_ROOT||'artifacts/ui-local-mcp-056';expect(['0.5.6','0.5.7','0.5.8','0.5.9','0.5.10']).toContain(version);expect(path.resolve(evidence).startsWith(path.resolve('artifacts')+path.sep)).toBe(true);const root=path.resolve(evidence+'/native-'+randomUUID()),directory=path.join(root,'notes'),profile=path.join(root,'profile');await fs.mkdir(directory,{recursive:true});await fs.mkdir(profile);
  const store=await new PersonalStore(directory).load();
  const invoke=async(route:string,method='GET',body?:any)=>{const url=new URL('/api/'+route,'http://local');const response=await store.respond(new Request(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}),url);expect(response.ok).toBe(true);return response.json();};
  const book=await invoke('spaces','POST',{kind:'personal',name:'Native local MCP'}),note=await invoke('documents','POST',{space_id:book.id,title:'本地导出与 AI 测试'}),snapshot={type:'doc',content:[{type:'heading',attrs:{blockId:randomUUID(),level:1},content:[{type:'text',text:'本地章节'}]},{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'本地原始正文'}]}]},doc=prosemirrorJSONToYDoc(schema,snapshot,'default');
  await invoke(`documents/${note.id}/local-state`,'PUT',{ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')});doc.destroy();await store.close();await fs.writeFile(path.join(profile,'personal-mode.json'),JSON.stringify({directory}));
  let app:ElectronApplication|undefined,client:Client|undefined;
  try{
    const executable=process.env.DESKTOP_EXECUTABLE;app=await _electron.launch({...(executable?{executablePath:path.resolve(executable)}:{}),args:['--no-sandbox','--password-store=basic',...(executable?[]:['apps/desktop']),'--document='+note.id],env:{...process.env,ANOTE_CLIENT_DATA_DIR:profile,ANOTE_DESKTOP_TEST:'1'}});
    expect(await app.evaluate(({app})=>app.getVersion())).toBe(version);if(executable){const appPath=await app.evaluate(({app})=>app.getAppPath());expect(appPath).toBe(path.join(path.dirname(path.resolve(executable)),'resources/app.asar'));await fs.mkdir(evidence+'/desktop',{recursive:true});await fs.writeFile(evidence+'/desktop/native-session.json',JSON.stringify({version,appPath,asarSha256:createHash('sha256').update(await fs.readFile(appPath)).digest('hex')}));}const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1450,900));const editor=page.getByTestId('editor');await expect(editor).toContainText('本地原始正文');
    const settings=await openWorkspaceSettings(page);await settings.getByRole('button',{name:'AI工具链',exact:true}).click();await settings.getByRole('checkbox',{name:'启用本地 MCP',exact:true}).click();await expect(settings.getByRole('checkbox',{name:'启用本地 MCP',exact:true})).toBeChecked();
    const token=await settings.getByLabel('本地 MCP 令牌（仅本次显示）',{exact:true}).inputValue(),endpoint=await settings.getByLabel('本地 MCP 接入地址',{exact:true}).inputValue();expect(endpoint).toBe('http://127.0.0.1:3112/mcp');expect(token).toMatch(/^anote_local_/);
    client=new Client({name:'Native local MCP verification',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const call=async(name:string,args:any={})=>{const result=await client!.callTool({name,arguments:args});expect(result.isError,JSON.stringify(result.content)).not.toBe(true);return result.structuredContent as any;};
    const previous=await call('read_note',{note_id:note.id});await settings.getByRole('button',{name:'关闭',exact:true}).click();
    const paragraph=editor.locator('p').filter({hasText:'本地原始正文'});await paragraph.click();await page.keyboard.press('End');await page.keyboard.insertText(' 尚未自动保存的输入');
    const stale=await client.callTool({name:'prepare_changes',arguments:{note_id:note.id,base_hash:previous.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[]}});expect(stale.isError).toBe(true);expect(JSON.parse((stale.content as any[])[0].text).status).toBe(409);
    const current=await call('read_note',{note_id:note.id});expect(JSON.stringify(current.blocks)).toContain('尚未自动保存的输入');
    const preview=await call('prepare_changes',{note_id:note.id,base_hash:current.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'insert',node:{type:'paragraph',content:[{type:'text',text:'MCP 写入并立即显示'}]}}]});await call('apply_changes',{change_id:preview.change_id,preview_hash:preview.preview_hash,operation_id:randomUUID()});await expect(editor).toContainText('MCP 写入并立即显示');await expect(editor).toContainText('尚未自动保存的输入');
    await editor.locator('h1').filter({hasText:'本地章节'}).click();const fold=editor.getByRole('button',{name:'折叠“本地章节”的内容',exact:true});expect(await fold.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);await fold.click();await expect(editor.getByText('MCP 写入并立即显示',{exact:true})).toBeHidden();
    const target=path.join(root,'export.md');const saveDialog=await app.evaluate(({dialog},file)=>{const original=dialog.showSaveDialog;(globalThis as any).__restore056Dialog=()=>dialog.showSaveDialog=original;dialog.showSaveDialog=(async(_window:any,options:any)=>{(globalThis as any).__056ExportName=options.defaultPath;return {canceled:false,filePath:file};}) as any;return true;},target);expect(saveDialog).toBe(true);
    await page.getByRole('button',{name:'笔记更多操作',exact:true}).click();await page.getByRole('button',{name:'导出 Markdown（.md）',exact:true}).click();await expect.poll(()=>fs.readFile(target,'utf8').catch(()=>'')).toContain('MCP 写入并立即显示');expect(await fs.readFile(target,'utf8')).toContain('尚未自动保存的输入');expect(await app.evaluate(()=>(globalThis as any).__056ExportName)).toBe(note.title+'.md');await app.evaluate(()=>(globalThis as any).__restore056Dialog());
    await client.close();client=undefined;await page.evaluate(()=>window.anote.leavePersonal());await expect.poll(()=>fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'}).then(()=>true,()=>false)).toBe(false);
  }finally{await client?.close().catch(()=>{});await app?.close().catch(()=>{});}
});
