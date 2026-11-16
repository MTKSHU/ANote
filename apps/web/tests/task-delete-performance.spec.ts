import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import * as Y from "yjs";
import {prosemirrorJSONToYDoc} from "@tiptap/y-tiptap";
import {schema,EDITOR_SCHEMA_VERSION} from "@anote/document-model";
import {api,login} from "./helpers";
import {person} from "./mcp-helpers";

test("large TODO deletion avoids full checkbox walks and keeps reading/viewer/new-node permissions",async({page,request,browser})=>{
  const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"删除响应回归"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"大量任务与删除"},owner);
  const paragraph=(text:string)=>({type:"paragraph",attrs:{blockId:randomUUID()},content:[{type:"text",text}]}),tail="Deletion surface: "+"abcdefghijklmnop ".repeat(12);
  const doc=prosemirrorJSONToYDoc(schema,{type:"doc",content:[{type:"taskList",attrs:{blockId:randomUUID()},content:Array.from({length:2000},(_,index)=>({type:"taskItem",attrs:{checked:false},content:[paragraph("任务 "+index)]}))},paragraph(tail)]},"default");
  try{await api(request,"POST",`documents/${note.id}/offline-sync`,{schema:EDITOR_SCHEMA_VERSION,opId:randomUUID(),ystate:Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64")},owner);}finally{doc.destroy();}
  await login(page,owner);await page.goto("/?doc="+note.id);const editor=page.getByTestId("editor");await expect(editor.locator('input[type="checkbox"]')).toHaveCount(2000);
  const initialSelection=await editor.evaluate((element,text)=>{const editor=(element as any).editor;let end=-1,blockId="";editor.state.doc.forEach((node:any,pos:number)=>{if(node.type.name==="paragraph"&&node.textContent===text){end=pos+node.nodeSize-1;blockId=node.attrs.blockId;}});if(end<0||!blockId)throw new Error("Expected deletion surface");editor.chain().setTextSelection(end).focus().run();return {end,blockId};},tail);
  await expect.poll(()=>editor.evaluate((element,end)=>{const editor=(element as any).editor;return editor.view.hasFocus()&&editor.state.selection.empty&&editor.state.selection.to===end;},initialSelection.end)).toBe(true);
  const surface=editor.locator(`:scope > p[data-block-id="${initialSelection.blockId}"]`);
  await editor.evaluate(element=>{
    const root=element as HTMLElement&{querySelectorAll:typeof element.querySelectorAll},original=root.querySelectorAll.bind(root);
    (window as any).__taskWalks=0;root.querySelectorAll=function(selector:string){if(selector==='li[data-type="taskItem"] input[type="checkbox"]')(window as any).__taskWalks++;return original(selector);} as typeof root.querySelectorAll;
  });
  for(let index=0;index<32;index++)await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowLeft");await page.keyboard.press("ArrowRight");
  await expect(surface).toHaveText(tail.slice(0,-32));expect(await surface.textContent()).toBe(tail.slice(0,-32));expect(await page.evaluate(()=>(window as any).__taskWalks)).toBe(0);
  await page.getByRole("button",{name:"阅读",exact:true}).click();await expect(editor).toHaveAttribute("contenteditable","false");
  const first=page.getByRole("checkbox",{name:"待办：任务 0",exact:true});await expect(first).toBeEnabled();await first.check();await expect(first).toBeChecked();
  const viewer=await person(request),sharing=await api(request,"GET",`documents/${note.id}/sharing`,undefined,owner);await api(request,"PATCH",`documents/${note.id}/sharing`,{visibility:"private",access_revision:sharing.access_revision,collaborators:[{user_id:viewer.user.id,role:"viewer"}]},owner);
  const context=await browser.newContext();try{
    const peer=await context.newPage();await login(peer,viewer);await peer.goto("/?doc="+note.id);await expect(peer.getByRole("checkbox",{name:"待办：任务 0",exact:true})).toBeDisabled();
    await page.getByRole("button",{name:"编辑",exact:true}).click();
    await editor.evaluate(element=>{const editor=(element as any).editor;editor.commands.insertContentAt(editor.state.doc.content.size,{type:"taskList",content:[{type:"taskItem",attrs:{checked:false},content:[{type:"paragraph",content:[{type:"text",text:"新增协作任务"}]}]}]});});
    await expect(page.getByRole("checkbox",{name:"待办：新增协作任务",exact:true})).toBeEnabled();await expect(peer.getByRole("checkbox",{name:"待办：新增协作任务",exact:true})).toBeDisabled();
  }finally{await context.close();}
  await page.keyboard.press("ControlOrMeta+s");await page.reload();await expect(page.getByRole("checkbox",{name:"待办：任务 0",exact:true})).toBeChecked();await expect(page.getByTestId("editor").locator(`:scope > p[data-block-id="${initialSelection.blockId}"]`)).toHaveText(tail.slice(0,-32));
});
