import { test, expect, _electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { slash } from "../../web/tests/helpers";
async function launch(profile: string, directory: string) {
  const application = await _electron.launch({
    ...(process.env.PERSONAL_PACKAGED === "1"
      ? {
          executablePath: path.resolve(
            "artifacts/releases/ANote-linux-x64/ANote",
          ),
        }
      : {}),
    args:
      process.env.PERSONAL_PACKAGED === "1"
        ? ["--no-sandbox"]
        : ["--no-sandbox", "apps/desktop"],
    env: {
      ...process.env,
      ANOTE_LOCALE: "zh-CN",
      ANOTE_CLIENT_DATA_DIR: profile,
      ANOTE_DESKTOP_TEST: "0",
    },
  });
  await application.evaluate(({ dialog, session }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    (globalThis as any).externalRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const remote = /^(https?|wss?):/.test(details.url);
      if (remote) (globalThis as any).externalRequests.push(details.url);
      callback({ cancel: remote });
    });
  }, directory);
  expect(await application.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);
  expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(
    process.env.PERSONAL_PACKAGED === "1",
  );
  return { application, page: await application.firstWindow() };
}
test("无网络无账号：本地知识库、附件、公式、导图和关闭前保存，重启后恢复", async () => {
  const root = path.resolve(
      "artifacts/desktop/personal-profiles",
      randomUUID(),
    ),
    profile = path.join(root, "profile"),
    directory = path.join(root, "notes");
  await fs.mkdir(directory, { recursive: true });
  let client = await launch(profile, directory);
  try {
    expect(await client.application.evaluate(({ app }) => app.getName())).toBe("ANote");
    await expect(client.page).toHaveURL("anote://app/");
    await expect(client.page).toHaveTitle("ANote");
    await expect(client.page.getByRole("heading", { name: "ANote", exact: true })).toBeVisible();
    await client.page
      .getByRole("button", { name: "本地个人笔记", exact: true })
      .click();
    await expect(client.page.locator(".academic-brand")).toHaveText("ANote");
    await expect(client.page).toHaveTitle("ANote");
    expect(
      (await client.page.evaluate(() => window.anote.state())).personal,
    ).toBe(true);
    await client.page.getByRole("button", { name: "设置", exact: true }).click();
    const preferences = client.page.getByRole("dialog", { name: "设置", exact: true });
    await preferences.getByLabel("昵称", { exact: true }).fill("离线研究者");
    await preferences.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(preferences.locator(".profile-card h3")).toHaveText("离线研究者");
    await preferences.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      client.page.getByRole("button", { name: /^我的团队/ }),
    ).toHaveCount(0);
    await client.page
      .locator(".academic-page-actions")
      .getByRole("button", { name: "新建笔记", exact: true })
      .click();
    await expect(client.page.getByTestId("editor")).toBeVisible();
    await client.page
      .getByLabel("笔记标题", { exact: true })
      .fill("完全离线的研究记录");
    await client.page.getByLabel("笔记标题", { exact: true }).press("Control+s");
    await expect(client.page.getByTestId("document-sync")).toHaveText("已保存到本地");
    const sidebar=client.page.locator('.academic-sidebar [data-sidebar-group="personal"]');
    await expect(sidebar.locator('.sidebar-library')).toHaveCount(1);
    await sidebar.getByRole("button",{name:/^固定到侧栏 /}).click();
    await expect(sidebar.getByRole("button",{name:/^取消固定 /})).toHaveAttribute("aria-pressed","true");
    expect(JSON.parse(await fs.readFile(path.join(directory,".anote/catalog.json"),"utf8")).documents[0].title).toBe("完全离线的研究记录");
    await client.page.getByRole("button",{name:"返回知识库",exact:true}).click();
    await client.page.locator(".academic-page-actions").getByRole("button",{name:"新建笔记",exact:true}).click();
    await client.page.getByLabel("笔记标题",{exact:true}).fill("离线同库切换目标");
    await client.page.getByLabel("笔记标题",{exact:true}).press("Control+s");
    await client.page.getByRole("complementary",{name:"同库笔记",exact:true}).getByRole("button",{name:"完全离线的研究记录",exact:true}).click();
    await expect(client.page.getByLabel("笔记标题",{exact:true})).toHaveValue("完全离线的研究记录");
    await client.page.getByTestId("editor").locator("p").last().click();
    await client.page.keyboard.insertText("## 离线实验");
    await expect(client.page.getByTestId("editor").locator("h2")).toHaveText(
      "离线实验",
    );
    await client.page.keyboard.press("Enter");
    await client.page.keyboard.insertText("断网也可以记录。");
    await client.page.keyboard.press("Meta+s");
    await expect(client.page.getByTestId("document-sync")).toHaveText("已保存到本地");
    const localCatalog=JSON.parse(await fs.readFile(path.join(directory,".anote/catalog.json"),"utf8"));
    expect(JSON.parse(await fs.readFile(path.join(directory,".anote/notes",localCatalog.documents[0].id+".json"),"utf8")).snapshot.content.some((node:any)=>JSON.stringify(node).includes("断网也可以记录"))).toBe(true);
    await client.page.keyboard.press("Enter");
    const localEditor=client.page.getByTestId("editor");
    await localEditor.evaluate(el=>{(window as any).__imeNode=el;});
    await localEditor.dispatchEvent("compositionstart",{data:""});
    await client.page.keyboard.insertText("shuru");
    await client.page.waitForTimeout(2400);
    expect(await localEditor.evaluate(el=>el===(window as any).__imeNode)).toBe(true);
    await expect(localEditor).toBeFocused();await expect(localEditor).toContainText("shuru");
    await localEditor.dispatchEvent("compositionend",{data:"输入"});
    await localEditor.evaluate(el=>{const e=(el as any).editor,{from}=e.state.selection;e.view.dispatch(e.state.tr.insertText("输入",from-5,from));});
    await client.page.keyboard.press("Enter");await client.page.keyboard.type("- [ ] ");await client.page.keyboard.insertText("离线任务");
    await client.page.locator(".document-actions").getByRole("button",{name:"阅读",exact:true}).click();
    await client.page.getByRole("checkbox",{name:"待办：离线任务"}).check();
    await client.page.locator(".document-actions").getByRole("button",{name:"编辑",exact:true}).click();
    await client.page.getByTestId("editor").evaluate(el=>{const e=(el as any).editor;e.commands.insertContentAt(e.state.doc.content.size,{type:"paragraph"});});
    await client.page
      .getByLabel("上传附件文件", { exact: true })
      .setInputFiles("artifacts/server/fixtures/sample.png");
    await expect(client.page.locator(".media-resource img")).toHaveJSProperty(
      "naturalWidth",
      64,
    );
    const savedImage=path.join(root,"saved-image.png");
    await client.application.evaluate(async({Menu,dialog,BrowserWindow},destination)=>{
      const original=Menu.buildFromTemplate;let saving:Promise<void>|undefined;
      dialog.showSaveDialog=async()=>({canceled:false,filePath:destination});
      Menu.buildFromTemplate=((items:any[])=>{const entry=items.find(item=>item.label==="图片另存为…");if(entry)saving=entry.click();return {popup(){}};}) as any;
      try{const win=BrowserWindow.getAllWindows()[0],src=await win.webContents.executeJavaScript('document.querySelector(".media-resource img").src');win.webContents.emit("context-menu",{}, {mediaType:"image",srcURL:src,altText:"sample.png",isEditable:false});await saving;}finally{Menu.buildFromTemplate=original;}
    },savedImage);
    expect(await fs.readFile(savedImage)).toEqual(await fs.readFile("artifacts/server/fixtures/sample.png"));
    await expect(client.page.locator('.media-resource')).toHaveCSS('border-top-width','0px');
    await expect(client.page.locator('.media-resource')).toHaveCSS('padding','0px');
    await expect(client.page.locator('.media-resource figcaption,.media-resource .attachment-details')).toHaveCount(0);
    await client.page.locator('.media-resource img').click();
    await expect(client.page.getByRole('dialog',{name:'媒体预览',exact:true})).toHaveCount(0);
    await client.page.getByLabel('媒体宽度',{exact:true}).selectOption('50');
    await client.page.getByRole('button',{name:'媒体右对齐',exact:true}).click();
    await slash(client.page, "思维导图");
    await expect(client.page.getByTestId("mind-map")).toBeVisible();
    await client.page
      .getByTestId("mind-map")
      .getByRole("button", { name: "添加子节点", exact: true })
      .click();
    const localMap=client.page.getByTestId("mind-map");
    await localMap.locator("input").press("Escape");
    await expect(localMap.locator("input")).toHaveCount(0);
    await localMap.locator(".mind-map-node").first().dblclick();
    await localMap.locator("input").fill("离线导图主题");await localMap.locator("input").press("Escape");
    await localMap.getByRole("button",{name:"全屏查看思维导图",exact:true}).click();
    await expect.poll(()=>client.page.evaluate(()=>!!document.fullscreenElement)).toBe(true);
    await localMap.getByRole("button",{name:"放大思维导图",exact:true}).click();
    await expect(localMap.getByLabel("思维导图缩放比例")).toHaveText("120%");
    await localMap.getByRole("button",{name:"退出思维导图全屏",exact:true}).click();
    await expect.poll(()=>client.page.evaluate(()=>document.fullscreenElement===null)).toBe(true);
    await client.page.getByRole("button", { name: "选中整个思维导图", exact: true }).click();
    await client.page.keyboard.press("Delete");
    await expect(client.page.getByTestId("mind-map")).toHaveCount(0);
    await client.page.keyboard.press("ControlOrMeta+z");
    await expect(client.page.getByTestId("mind-map").locator(".mind-map-node")).toHaveCount(2);
    await slash(client.page, "代码块", "mermaid");
    await client.page.getByLabel("代码语言").selectOption("mermaid");
    await client.page.locator(".academic-code-block code").click();
    await client.page.keyboard.insertText("flowchart LR");
    await client.page.keyboard.press("Enter");
    await client.page.keyboard.insertText(" A[离线输入] --> B[离线结果]");
    await client.page.getByRole("button", { name: "预览图表", exact: true }).click();
    await expect(client.page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("离线结果");
    const diagramCanvas=client.page.locator(".mermaid-viewport"), diagramZoom=Number(await diagramCanvas.getAttribute("data-zoom"));
    await client.page.getByRole("button",{name:"放大 Mermaid 图表",exact:true}).click();
    expect(Number(await diagramCanvas.getAttribute("data-zoom"))).toBeCloseTo(diagramZoom*1.2,3);
    const diagramBox=(await diagramCanvas.boundingBox())!, diagramX=Number(await diagramCanvas.getAttribute("data-pan-x"));
    await client.page.mouse.move(diagramBox.x+40,diagramBox.y+40);await client.page.mouse.down();await client.page.mouse.move(diagramBox.x+95,diagramBox.y+70);await client.page.mouse.up();
    expect(Number(await diagramCanvas.getAttribute("data-pan-x"))).toBeCloseTo(diagramX+55,0);
    await client.page.getByRole("button",{name:"适应 Mermaid 画布",exact:true}).click();
    expect(Number(await diagramCanvas.getAttribute("data-zoom"))).toBeCloseTo(diagramZoom,3);
    await client.page.locator(".academic-code-block").getByRole("button", { name: "选中整个Mermaid 图表", exact: true }).click();
    await client.page.keyboard.press("Backspace");
    await expect(client.page.locator(".academic-code-block")).toHaveCount(0);
    await client.page.keyboard.press("ControlOrMeta+z");
    await expect(client.page.locator(".academic-code-block")).toHaveCount(1);
    await client.page.getByTestId("editor").evaluate(el => { const editor=(el as any).editor;editor.commands.insertContentAt(editor.state.doc.content.size,{type:"paragraph"}); });
    await slash(client.page, "LaTeX 公式", "latex");
    await expect(client.page.locator(".math-block .katex")).toBeVisible();
    await expect(client.page.getByTestId("document-sync")).toHaveText(
      "已保存到本地",
    );
    await client.page
      .getByTestId("editor")
      .locator(":scope > p")
      .last()
      .click();
    await client.page.keyboard.insertText("关闭前最后一句。");
    const noteList=client.page.getByRole("complementary",{name:"同库笔记",exact:true});
    await noteList.getByRole("button",{name:"离线同库切换目标",exact:true}).click();
    await expect(client.page.getByLabel("笔记标题",{exact:true})).toHaveValue("离线同库切换目标");
    await noteList.getByRole("button",{name:"完全离线的研究记录",exact:true}).click();
    await expect(client.page.getByTestId("editor")).toContainText("关闭前最后一句。");
    await noteList.getByRole("button",{name:"隐藏笔记列表",exact:true}).click();
    await client.page.getByRole('button',{name:'收起侧边栏',exact:true}).click();
    await expect(client.page.getByRole('button',{name:'展开侧边栏',exact:true})).toBeVisible();
    expect(
      await client.application.evaluate(
        () => (globalThis as any).externalRequests,
      ),
    ).toEqual([]);
    await client.application.close();
    client = await launch(profile, directory);
    await expect(client.page.getByRole("button",{name:"显示笔记列表",exact:true})).toBeVisible();
    await expect(client.page.getByRole('button',{name:'展开侧边栏',exact:true})).toBeVisible();
    await client.page.getByRole('button',{name:'展开侧边栏',exact:true}).click();
    await expect(client.page.locator(".academic-user")).toContainText("离线研究者");
    await expect(client.page.locator('.academic-sidebar [data-sidebar-group="personal"]').getByRole("button",{name:/^取消固定 /})).toHaveAttribute("aria-pressed","true");
    await expect(client.page.getByTestId("editor")).toContainText(
      "关闭前最后一句。",
    );
    await expect(
      client.page.getByLabel("笔记标题", { exact: true }),
    ).toHaveValue("完全离线的研究记录");
    await expect(
      client.page.getByTestId("mind-map").locator(".mind-map-node"),
    ).toHaveCount(2);
    await expect(client.page.getByTestId("mind-map").locator(".mind-map-node-label").first()).toHaveText("离线导图主题");
    await expect(client.page.locator('.media-layout')).toHaveAttribute('data-alignment','right');
    await expect(client.page.locator('.media-frame')).toHaveAttribute('style',/width: 50%/);
    await expect(client.page.getByRole("checkbox",{name:"待办：离线任务"})).toBeChecked();
    await expect(client.page.locator(".math-block .katex")).toBeVisible();
    await expect(client.page.locator(".media-resource img")).toHaveJSProperty(
      "naturalWidth",
      64,
    );
    await expect(
      client.page.getByRole("button", { name: "共享", exact: true }),
    ).toHaveCount(0);
    await expect(client.page.frameLocator('iframe[title="Mermaid 图表"]').locator("svg")).toContainText("离线结果");
    const state = await client.page.evaluate(() => window.anote.state());
    expect(state.token).toBeNull();
    expect(state.user?.name).toBe("离线研究者");
    await client.page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    await client.page.getByRole("tab",{name:"命名版本",exact:true}).click();await client.page.getByLabel("版本号",{exact:true}).fill("v1.0");await client.page.getByLabel("版本说明", { exact: true }).fill("个人历史保留");
    await client.page.getByRole("button", { name: "保存当前版本", exact: true }).click();
    const history = client.page.locator(".history-entry").filter({ hasText: "个人历史保留" });
    await expect(history.locator(".history-editors")).toContainText("离线研究者");
    await history.getByRole("button", { name: "查看版本", exact: true }).click();
    await expect(client.page.getByRole("dialog", { name: "历史版本预览" }).locator(".history-editors")).toContainText("离线研究者");
    await client.page.getByRole("button", { name: "关闭预览", exact: true }).click();
    await client.page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    expect(state.workspace).toBe(directory);
    expect(
      await client.application.evaluate(
        () => (globalThis as any).externalRequests,
      ),
    ).toEqual([]);
    await client.page.screenshot({
      path: "artifacts/desktop/personal-offline.png",
    });
  } finally {
    await client.application.close();
  }
});
test("本地个人目录相互隔离，可切换到团队登录且不自动上传笔记", async () => {
  const root = path.resolve(
      "artifacts/desktop/personal-profiles",
      randomUUID(),
    ),
    a = path.join(root, "a"),
    b = path.join(root, "b");
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  const { application, page } = await launch(path.join(root, "profile"), a);
  try {
    await page
      .getByRole("button", { name: "本地个人笔记", exact: true })
      .click();
    await page
      .locator(".academic-page-actions")
      .getByRole("button", { name: "新建笔记", exact: true })
      .click();
    await expect(page.getByTestId("editor")).toBeVisible();
    await page.getByLabel("笔记标题", { exact: true }).fill("目录 A 私人笔记");
    await page.getByLabel("笔记标题", { exact: true }).press("Tab");
    const aState=await page.evaluate(()=>window.anote.state()),aNote=new URL(page.url()).searchParams.get("doc")!;
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, b);
    await page
      .getByRole("button", { name: "切换个人目录", exact: true })
      .click();
    await expect(page.locator(".note-table-row")).toHaveCount(0);
    await expect(page.getByTestId("editor")).toHaveCount(0);
    await page.evaluate(({id,scope})=>window.anote.selectDocument(id,scope),{id:aNote,scope:aState.serverURL+"|"+aState.user!.id});
    expect((await page.evaluate(()=>window.anote.state())).lastDoc).toBeNull();
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, a);
    await page
      .getByRole("button", { name: "切换个人目录", exact: true })
      .click();
    await expect(page.getByLabel("笔记标题", { exact: true })).toHaveValue(
      "目录 A 私人笔记",
    );
    await page
      .getByRole("button", { name: "连接团队空间", exact: true })
      .click();
    await expect(page.getByLabel("服务地址", { exact: true })).toBeVisible();
    const catalog = JSON.parse(
      await fs.readFile(path.join(a, ".anote/catalog.json"), "utf8"),
    );
    expect(catalog.documents).toHaveLength(1);
    expect(catalog.documents[0].title).toBe("目录 A 私人笔记");
  } finally {
    await application.close();
  }
});
