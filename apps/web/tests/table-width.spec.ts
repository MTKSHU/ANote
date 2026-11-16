import {EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {api,admin,login} from './helpers';
import {connect,call} from './mcp-helpers';

const p=(text:string)=>({type:'paragraph',content:text?[{type:'text',text}]:[]});
async function fixture(request:any,merged=false){
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');expect((await request.get('/api/platform/public').then((r:any)=>r.json())).public_origin).toBe(process.env.QA_PUBLIC_ORIGIN||'http://127.0.0.1:3260');
  const owner=await admin(request),book=await api(request,'POST','spaces',{kind:'personal',name:'列宽验收 '+randomUUID()},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'列宽 '+randomUUID()},owner);
  const row=(texts:string[],header=false)=>({type:'tableRow',content:texts.map(text=>({type:header?'tableHeader':'tableCell',content:[p(text)]}))});
  const table={type:'table',content:[row(['编号','详细说明','状态'],true),row(['1','较长的中文说明和 English description，内容应自动分配宽度而非挤满短编号列。'.repeat(5),'完成']),row(['2','短说明','待办'])]};
  if(merged)table.content[0].content=[{type:'tableHeader',attrs:{colspan:2,rowspan:1,background:'#dbeafe'},content:[p('合并表头：说明与编号')]},{type:'tableHeader',content:[p('状态')]}] as any;
  const token=await api(request,'POST','me/integrations/tokens',{name:'Width QA',scopes:['notes:read','notes:write']},owner),client=await connect(token.token);
  try{const read=await call(client,'read_note',{note_id:note.id}),change=await call(client,'prepare_changes',{note_id:note.id,base_hash:read.base_hash,schema_version:EDITOR_SCHEMA_VERSION,operations:[{action:'insert',node:table}]});await call(client,'apply_changes',{change_id:change.change_id,preview_hash:change.preview_hash,operation_id:randomUUID()});}finally{await client.close();await api(request,'DELETE','me/integrations/'+token.id,undefined,owner);}
  return {owner,book,note};
}
async function open(page:Page,owner:any,id:string){
  await login(page,owner);await page.goto('/?scope=personal&doc='+id);const editor=page.getByTestId('editor');await expect(editor).toContainText('详细说明');
  const mode=page.locator('.document-mode-toggle');await expect(mode).toBeEnabled();if(await mode.getAttribute('data-mode')==='read')await mode.click();await expect(editor).toHaveAttribute('contenteditable','true');return editor.locator('table').first();
}
async function tools(page:Page){await page.getByTestId('editor').locator('td').first().click({button:'right'});const bar=page.getByRole('toolbar',{name:'表格操作',exact:true});await expect(bar).toBeVisible();return bar;}
async function widths(page:Page){return page.getByTestId('editor').locator('table').first().locator(':scope > colgroup > col').evaluateAll(cols=>cols.map(col=>col.getBoundingClientRect().width));}
async function stored(request:any,owner:any,id:string){const value=await api(request,'GET','documents/'+id,undefined,owner);return value.snapshot.content.find((n:any)=>n.type==='table');}
async function drag(page:Page,delta:number){
  const cell=page.getByTestId('editor').locator('table').first().locator('tr').first().locator('th,td').first(),box=(await cell.boundingBox())!;
  await page.mouse.move(box.x+box.width-2,box.y+box.height/2);await expect(page.getByTestId('editor')).toHaveClass(/resize-cursor/);await expect(page.locator('.column-resize-handle').first()).toBeVisible();
  await page.mouse.down();await page.mouse.move(box.x+box.width-2+delta,box.y+box.height/2,{steps:8});await page.mouse.up();await expect(page.getByTestId('document-sync')).toHaveText('已同步');
}

test('manual widths work after initial preparation, undo independently, survive reload and respect reading mode',async({page,request},info)=>{
  test.skip(info.project.name!=='desktop');const {owner,note}=await fixture(request);await open(page,owner,note.id);const before=await widths(page);await drag(page,70);const changed=await widths(page);expect(changed[0]).toBeGreaterThan(before[0]+40);
  await page.keyboard.press('ControlOrMeta+z');
  // Undo restores automatic widths. A scrollbar can change the available
  // page width, so verify the stored mode and equal automatic allocation.
  await expect.poll(async()=>(await stored(request,owner,note.id)).content[0].content[0].attrs.colwidth).toBeNull();
  await expect.poll(async()=>{const values=await widths(page);return Math.max(...values)-Math.min(...values);}).toBeLessThan(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');await expect.poll(async()=>Math.abs((await widths(page))[0]-changed[0])).toBeLessThan(2);await expect(page.getByTestId('document-sync')).toHaveText('已同步');
  await page.reload();await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','true');await expect.poll(async()=>Math.abs((await widths(page))[0]-changed[0])).toBeLessThan(2);
  await page.locator('.document-mode-toggle').click();await expect(page.getByTestId('editor')).toHaveAttribute('contenteditable','false');const saved=await stored(request,owner,note.id),box=(await page.getByTestId('editor').locator('th').first().boundingBox())!;
  await page.mouse.move(box.x+box.width-2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width+70,box.y+box.height/2);await page.mouse.up();expect(await stored(request,owner,note.id)).toEqual(saved);
  await page.locator('.document-mode-toggle').click();await drag(page,35);expect((await widths(page))[0]).toBeGreaterThan(changed[0]+20);
});

test('content fit and equal distribution preserve table content and merged cells, undo once and fit mobile themes',async({page,request},info)=>{
  const {owner,note}=await fixture(request,true);await login(page,owner);await page.goto('/?scope=personal&doc='+note.id);const editor=page.getByTestId('editor');await expect(editor).toContainText('合并表头');const mode=page.locator('.document-mode-toggle');await expect(mode).toBeEnabled();if(await mode.getAttribute('data-mode')==='read')await mode.click();await expect(editor).toHaveAttribute('contenteditable','true');
  const before=await stored(request,owner,note.id),bar=await tools(page);await bar.getByRole('button',{name:'按内容调整列宽',exact:true}).click();const fitted=await widths(page);expect(fitted[1]).toBeGreaterThan(fitted[2]);expect(fitted.every(w=>w>=47)).toBe(true);
  const table=editor.locator('table').first(),wrapper=table.locator('..');expect((await table.boundingBox())!.width).toBeLessThanOrEqual((await wrapper.boundingBox())!.width+2);
  await expect(page.getByTestId('document-sync')).toHaveText('已同步');const fittedData=await stored(request,owner,note.id);expect(fittedData.content[0].content[0].attrs).toMatchObject({colspan:2,background:'#dbeafe',colwidth:expect.any(Array)});expect(fittedData.content[0].content[0].attrs.colwidth).toHaveLength(2);
  const strip=(value:any):any=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='colwidth').map(([key,v])=>[key,strip(v)])):value;expect(strip(fittedData)).toEqual(strip(before));
  await (await tools(page)).getByRole('button',{name:'平均分配列宽',exact:true}).click();const equal=await widths(page);expect(Math.max(...equal)-Math.min(...equal)).toBeLessThan(2);
  await page.keyboard.press('ControlOrMeta+z');await expect.poll(async()=>Math.max(...(await widths(page)).map((w,i)=>Math.abs(w-fitted[i])))).toBeLessThan(2);
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await tools(page);const group=page.getByRole('group',{name:'表格选区工具'});
    await expect.poll(async()=>{const bounds=await group.boundingBox();return !!bounds&&bounds.x>=-1&&bounds.x+bounds.width<=page.viewportSize()!.width+1;}).toBe(true);
    if(theme==='dark')expect(await group.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 255, 255)');await page.screenshot({path:`artifacts/table-width/${info.project.name}-${theme}.png`});
  }
  await page.keyboard.press('Escape');await expect(page.getByTestId('document-sync')).toHaveText('已同步');await page.reload();await expect(page.getByTestId('editor')).toContainText('合并表头');await expect.poll(async()=>Math.max(...(await widths(page)).map((w,i)=>Math.abs(w-fitted[i])))).toBeLessThan(2);
});

test('resize plugin starts read-only, cancels a drag on permission loss and never writes the read-only table',async({page},info)=>{
  test.skip(info.project.name!=='desktop');
  const result=await build({stdin:{contents:`import {Editor} from '@tiptap/core';import StarterKit from '@tiptap/starter-kit';import {TableRow,TableCell,TableHeader} from '@tiptap/extension-table';import {columnResizingPluginKey} from '@tiptap/pm/tables';import {InteractiveTable} from './packages/editor/src/table-resize.ts';window.widthKey=columnResizingPluginKey;window.widthEditor=new Editor({element:document.querySelector('#root'),editable:false,extensions:[StarterKit,InteractiveTable.configure({resizable:true,cellMinWidth:48}),TableRow,TableCell,TableHeader],content:'<table><tr><td>A</td><td>B</td></tr></table><p></p>'});`,resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife'});
  await page.setContent('<html><head><style>table{width:600px;table-layout:fixed;border-collapse:collapse}td{border:1px solid;padding:12px}td p{margin:0}</style></head><body><div id="root"></div></body></html>');await page.addScriptTag({content:result.outputFiles[0].text});
  expect(await page.evaluate(()=>!!(window as any).widthKey.getState((window as any).widthEditor.state))).toBe(true);await page.evaluate(()=>(window as any).widthEditor.setEditable(true));
  const cell=page.locator('td').first(),before=await page.evaluate(()=>(window as any).widthEditor.getJSON()),box=(await cell.boundingBox())!;await page.mouse.move(box.x+box.width-2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width+100,box.y+box.height/2,{steps:5});expect(await page.evaluate(()=>(window as any).widthKey.getState((window as any).widthEditor.state).dragging)).toBeTruthy();await page.evaluate(()=>(window as any).widthEditor.setEditable(false));await page.mouse.up();
  expect(await page.evaluate(()=>(window as any).widthEditor.getJSON())).toEqual(before);expect(await page.evaluate(()=>(window as any).widthKey.getState((window as any).widthEditor.state).dragging)).toBe(false);
  expect(Math.abs((await cell.boundingBox())!.width-box.width)).toBeLessThan(2);
  await page.evaluate(()=>(window as any).widthEditor.destroy());
});
