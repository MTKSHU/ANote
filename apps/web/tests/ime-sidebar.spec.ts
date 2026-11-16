import {test,expect,type Page,type APIRequestContext} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin,login,chooseTheme,switchWorkspace,accountMenu,signOutWorkspace} from "./helpers";

async function person(request:APIRequestContext,name="分组用户") {
  const root=await admin(request),username="ime-ui-"+randomUUID().slice(0,8),password="Ime-sidebar-fixture-123!";
  await api(request,"POST","users",{username,password,name},root);
  return {...await api(request,"POST","auth/login",{username,password}),username,password};
}
async function setup(page:Page,request:APIRequestContext) {
  await page.addInitScript(()=>Object.defineProperty(navigator,"platform",{get:()=>"MacIntel"}));
  const owner=await person(request),book=await api(request,"POST","spaces",{kind:"personal",name:"输入法实验"},owner),note=await api(request,"POST","documents",{space_id:book.id,title:"拼音修改"},owner);
  await login(page,owner);await page.goto("/?doc="+note.id);await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","true");return {owner,book,note};
}

for(const backspace of [false,true])test(`真实组合输入缩短再补字${backspace?"，包含 Backspace 按键":""}，不打断预编辑或残留拼音`,async({page,request})=>{
  const {owner,note}=await setup(page,request),editor=page.getByTestId("editor"),cdp=await page.context().newCDPSession(page);
  await editor.click();await editor.evaluate(dom=>{(window as any).__imeRoot=dom;(window as any).__imeEditor=(dom as any).editor;});
  try{
    await cdp.send("Input.imeSetComposition",{text:"shuru",selectionStart:5,selectionEnd:5});await expect(editor).toHaveText("shuru");
    if(backspace)await page.keyboard.press("Backspace");
    await cdp.send("Input.imeSetComposition",{text:"shur",selectionStart:4,selectionEnd:4});await expect(editor).toHaveText("shur");
    // A provider acknowledgement, save and metadata refresh must not replace
    // the composition's DOM selection with the previous model selection.
    await api(request,"POST",`documents/${note.id}/save`,{},owner);await page.evaluate(()=>window.dispatchEvent(new Event("anote-note-changed")));
    await cdp.send("Input.imeSetComposition",{text:"shuru",selectionStart:5,selectionEnd:5});await expect(editor).toHaveText("shuru");
    await cdp.send("Input.insertText",{text:"输入"});await expect(editor).toHaveText("输入");
    expect(await editor.evaluate(dom=>dom===(window as any).__imeRoot&&(dom as any).editor===(window as any).__imeEditor)).toBe(true);
    await page.keyboard.press("ControlOrMeta+s");await expect(page.getByTestId("document-sync")).toHaveText("已保存");
    const stored=await api(request,"GET",`documents/${note.id}`,undefined,owner);expect(stored.snapshot.content[0].content.map((t:any)=>t.text||"").join("")).toBe("输入");
    await page.reload();await expect(page.getByTestId("editor")).toHaveText("输入");
  }finally{await cdp.detach();}
});

test("标题、加粗与表格单元格内反复修改拼音，提交后普通退格仍正常",async({page,request})=>{
  await setup(page,request);const editor=page.getByTestId("editor"),cdp=await page.context().newCDPSession(page);
  try{for(const kind of ["heading","bold","table"]){
    await editor.evaluate((dom,kind)=>{const e=(dom as any).editor,p={type:"paragraph"};e.commands.setContent({type:"doc",content:[kind==="heading"?{type:"heading",attrs:{level:2}}:kind==="table"?{type:"table",content:[{type:"tableRow",content:[{type:"tableCell",content:[p]}]}]}:p]});let start:number|null=null;e.state.doc.descendants((node:any,pos:number)=>{if(start===null&&node.isTextblock)start=pos+1;});e.commands.focus(start);if(kind==="bold")e.commands.setBold();},kind);
    await expect(editor).toBeFocused();
    for(const text of ["shuru","shur","shu","sh","shuru"]){await cdp.send("Input.imeSetComposition",{text,selectionStart:text.length,selectionEnd:text.length});await expect(editor).toHaveText(text);}
    await cdp.send("Input.insertText",{text:"输入"});await expect(editor).toHaveText("输入");
    if(kind==="heading")await expect(editor.locator("h2")).toHaveText("输入");if(kind==="bold")await expect(editor.locator("strong")).toHaveText("输入");if(kind==="table")await expect(editor.locator("td")).toHaveText("输入");
    await page.keyboard.press("Backspace");await expect(editor).toHaveText("输");
  }}finally{await cdp.detach();}
});

test("分组折叠按账号隔离，侧栏偏好存储受限时仍能在本次会话折叠",async({page,request})=>{
  const owner=await person(request,"折叠账号A"),peer=await person(request,"折叠账号B");
  // Wait for logout to finish before navigating: leaving sooner can cancel
  // the request and keep the previous account's cookie in the next fixture.
  async function logout(){await signOutWorkspace(page);await expect(page.getByLabel("用户名",{exact:true})).toBeVisible();}
  await login(page,owner);await page.getByRole("button",{name:"折叠默认知识库",exact:true}).click();await logout();await login(page,peer);await expect(page.getByRole("button",{name:"折叠默认知识库",exact:true})).toHaveAttribute("aria-expanded","true");await logout();await login(page,owner);await expect(page.getByRole("button",{name:"展开默认知识库",exact:true})).toHaveAttribute("aria-expanded","false");
  await page.addInitScript(()=>{const read=Storage.prototype.getItem,write=Storage.prototype.setItem;Storage.prototype.getItem=function(key){if(key.startsWith("simple-notes:sidebar-group:"))throw new Error("Sidebar storage blocked");return read.call(this,key);};Storage.prototype.setItem=function(key,value){if(key.startsWith("simple-notes:sidebar-group:"))throw new Error("Sidebar storage blocked");return write.call(this,key,value);};});await page.reload();await page.getByRole("button",{name:"折叠默认知识库",exact:true}).click();await expect(page.getByRole("button",{name:"展开默认知识库",exact:true})).toHaveAttribute("aria-expanded","false");await accountMenu(page,"全部知识库");await expect(page.getByRole("button",{name:"展开默认知识库",exact:true})).toBeVisible();
});
