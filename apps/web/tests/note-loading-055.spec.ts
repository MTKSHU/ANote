import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {schema,EDITOR_SCHEMA_VERSION} from '@anote/document-model';
import {api,login} from './helpers';
import {person} from './mcp-helpers';

let harness='',styles='';
test.beforeAll(async({request})=>{
  expect(process.env.ANOTE_ISOLATED_TESTS).toBe('1');
  const expected=process.env.ANOTE_PREVIEW_PUBLIC_ORIGIN||'http://127.0.0.1:3200';
  expect(['http://127.0.0.1:3190','http://127.0.0.1:3200','http://127.0.0.1:3210']).toContain(expected);
  expect((await request.get('/api/platform/public').then(response=>response.json())).public_origin).toBe(expected);
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',logLevel:'silent',stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
    import {DocumentLoading} from './apps/desktop/renderer/document-loading';
    const root=createRoot(document.getElementById('root'));let props={requestKey:'first',pending:true};
    window.__noteLoading={render(next={}){props={...props,...next};flushSync(()=>root.render(<DocumentLoading {...props}/>));},unmount(){flushSync(()=>root.unmount());}};
  `}});
  harness=bundle.outputFiles![0].text;styles=await fs.readFile('apps/desktop/renderer/document-loading.css','utf8');
});
async function mount(page:Page,props:Record<string,unknown>={}){
  await page.setContent('<html data-theme="light"><head></head><body><main id="root"></main></body></html>');
  await page.addStyleTag({content:`:root{--muted:#667085}body{margin:0;background:#fff}html[data-theme=dark]{--muted:#a1adbd}html[data-theme=dark] body{background:#141b25}${styles}`});
  await page.addScriptTag({content:harness});
  await page.clock.install({time:new Date('2026-11-10T00:00:00Z')});await page.clock.pauseAt(new Date('2026-11-10T00:00:01Z'));
  await page.evaluate(props=>(window as any).__noteLoading.render(props),props);
}
const change=(page:Page,props:Record<string,unknown>)=>page.evaluate(props=>(window as any).__noteLoading.render(props),props);

test('indicator starts at 500ms and completion removes it without another timer tick',async({page})=>{
  await mount(page);await expect(page.getByTestId('note-loading-placeholder')).toBeVisible();
  await page.clock.runFor(499);await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);
  await page.clock.runFor(1);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();await expect(page.getByRole('status',{name:'正在读取笔记'})).toHaveCount(1);expect(await page.locator('.document-loading-dots > span').first().evaluate(dot=>Number(getComputedStyle(dot).opacity))).toBeGreaterThan(0);
  expect(await page.getByTestId('note-loading-indicator').evaluate(element=>element.closest('[aria-busy="true"]')===null)).toBe(true);
  await change(page,{pending:false});await expect(page.getByTestId('note-loading-placeholder')).toHaveCount(0);await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);
});

test('a fast body has no indicator flash and late callbacks cannot resurrect it',async({page})=>{
  await mount(page);await page.clock.runFor(200);await change(page,{pending:false});await page.clock.runFor(2000);
  await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);await expect(page.getByRole('status')).toHaveCount(0);
});

test('switching notes resets the delay and unmount cancels the pending display',async({page})=>{
  await mount(page);await page.clock.runFor(600);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();
  await change(page,{requestKey:'second'});await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);await page.clock.runFor(499);await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);
  await page.clock.runFor(1);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();await change(page,{requestKey:'third'});
  await page.evaluate(()=>(window as any).__noteLoading.unmount());await page.clock.runFor(2000);await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);
});

test('an error replaces the indicator immediately and is never hidden behind loading',async({page})=>{
  await mount(page);await page.clock.runFor(500);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();
  await change(page,{error:'阅读权限已撤销'});await expect(page.getByRole('alert')).toHaveText('阅读权限已撤销');await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);
  await page.clock.runFor(2000);await expect(page.getByRole('status')).toHaveCount(0);
});

test('three neutral gray dots appear and disappear in order in both themes',async({page},testInfo)=>{
  await mount(page);await page.clock.runFor(500);
  const dots=page.locator('.document-loading-dots > span');await expect(dots).toHaveCount(3);
  const phases=await page.evaluate(()=>{
    const dots=[...document.querySelectorAll<HTMLElement>('.document-loading-dots > span')];
    return [130,310,490,900,1060,1260].map(time=>{for(const dot of dots)for(const animation of dot.getAnimations()){animation.pause();animation.currentTime=time;}return dots.map(dot=>Number(getComputedStyle(dot).opacity));});
  });
  expect(phases[0][0]).toBeGreaterThan(.5);expect(phases[0][1]).toBe(0);expect(phases[0][2]).toBe(0);
  expect(phases[1][0]).toBeGreaterThan(.5);expect(phases[1][1]).toBeGreaterThan(.5);expect(phases[1][2]).toBe(0);
  expect(phases[2].every(value=>value>.5)).toBe(true);
  expect(phases[3][0]).toBe(0);expect(phases[3][1]).toBeGreaterThan(.5);expect(phases[3][2]).toBeGreaterThan(.5);
  expect(phases[4][0]).toBe(0);expect(phases[4][1]).toBe(0);expect(phases[4][2]).toBeGreaterThan(.5);expect(phases[5].every(value=>value===0)).toBe(true);
  // Freeze all three visible for screenshots; only the animation timing above
  // changes, not the layout or theme colors under inspection.
  await page.evaluate(()=>{for(const dot of document.querySelectorAll<HTMLElement>('.document-loading-dots > span'))for(const animation of dot.getAnimations())animation.currentTime=490;});
  const light=await dots.first().evaluate(dot=>getComputedStyle(dot).backgroundColor);await page.screenshot({path:testInfo.outputPath('loading-light.png')});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');const dark=await dots.first().evaluate(dot=>getComputedStyle(dot).backgroundColor);expect(dark).not.toBe(light);await page.screenshot({path:testInfo.outputPath('loading-dark.png')});
  for(const color of [light,dark]){const channels=color.match(/\d+/g)!.map(Number);expect(Math.max(...channels)-Math.min(...channels)).toBeLessThan(40);}
});

test('reduced motion keeps a static accessible indicator and a body overlay takes no layout space',async({page})=>{
  const hint='首次打开需要连接服务器；已经缓存的笔记可以离线使用。';
  await page.emulateMedia({reducedMotion:'reduce'});await mount(page,{overlay:true,hint});await page.clock.runFor(500);
  await expect(page.getByRole('status',{name:'正在读取笔记'})).toBeVisible();
  const explanation=page.getByText(hint,{exact:true});await expect(explanation).toBeVisible();expect(await explanation.ariaSnapshot()).toContain(hint);expect(await explanation.evaluate(element=>element.closest('[aria-hidden="true"]')===null)).toBe(true);
  const result=await page.evaluate(()=>({height:document.querySelector('.document-loading')!.getBoundingClientRect().height,dots:[...document.querySelectorAll<HTMLElement>('.document-loading-dots > span')].map(dot=>({animation:getComputedStyle(dot).animationName,opacity:Number(getComputedStyle(dot).opacity)}))}));
  expect(result.height).toBe(0);expect(result.dots.every(dot=>dot.animation==='none'&&dot.opacity>0)).toBe(true);
});

async function fixture(request:APIRequestContext){
  const owner=await person(request),book=await api(request,'POST','spaces',{kind:'personal',name:'055 loading'},owner),note=await api(request,'POST','documents',{space_id:book.id,title:'延迟加载提示'},owner),snapshot={type:'doc',content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'已可阅读的正文 '+note.id}]}]},document=prosemirrorJSONToYDoc(schema,snapshot,'default');
  try{await api(request,'POST',`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,migrationEncoding:2,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64')},owner);}finally{document.destroy();}return {owner,note};
}

test('actual note loading stops at the first readable preview while collaboration is still waiting',async({page,request},testInfo)=>{
  const {owner,note}=await fixture(request);await login(page,owner);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/documents/${note.id}/preview`,async route=>{await held;await route.continue();});await page.routeWebSocket(/\/collab/,()=>{});
  try{
    await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('actual-note-loading.png')});release();
    const preview=page.getByTestId('document-preview');await expect(preview).toHaveAttribute('data-view-ready','true');await expect(preview).toContainText('已可阅读的正文 '+note.id);await expect(preview).toHaveAttribute('data-edit-ready','false');
    await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);await expect(page.getByTestId('editor')).toHaveCount(0);
  }finally{release();}
});

test('actual delayed permission denial ends the animation without exposing a body',async({page,request})=>{
  const {owner,note}=await fixture(request);await login(page,owner);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
  await page.route(`**/api/documents/${note.id}/preview`,async route=>{await held;await route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'阅读权限已撤销'})});});
  try{
    await page.goto('/?scope=personal&doc='+note.id);await expect(page.getByTestId('note-loading-indicator')).toBeVisible();release();
    await expect(page.getByRole('alert')).toContainText('阅读权限已撤销');await expect(page.getByTestId('note-loading-indicator')).toHaveCount(0);await expect(page.getByTestId('document-preview-body')).toHaveCount(0);await expect(page.getByTestId('editor')).toHaveCount(0);
  }finally{release();}
});
