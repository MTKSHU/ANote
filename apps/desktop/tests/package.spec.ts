import { test, expect, _electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { api, admin, chooseTheme, uiGeometry } from "../../web/tests/helpers";
test("打包后的 Linux 客户端：ASAR、隔离服务登录、受限能力和退出撤销会话", async ({
  request,
}) => {
  const origin = process.env.BASE_URL || "http://anote.internal:3000",
    account = await admin(request),
    title = "客户端打包验证 " + randomUUID().slice(0, 8);
  await api(request, "PATCH", "me/preferences", { theme: "light" }, account);
  // Other packaged runs retain pins on the isolated admin account. Leave room
  // to verify this run's library becomes a recent item after unpinning it.
  for (const previous of (await api(request,"GET","spaces",undefined,account)).filter((book:any)=>book.sidebar_pinned))
    await api(request,"PATCH",`spaces/${previous.id}/sidebar-pin`,{pinned:false},account);
  const library = await api(
      request,
      "POST",
      "spaces",
      { name: title, kind: "personal" },
      account,
    ),
    note = await api(
      request,
      "POST",
      "documents",
      { space_id: library.id, title },
      account,
    ),
    base = await api(
      request,
      "GET",
      `documents/${note.id}/export`,
      undefined,
      account,
    );
  await api(
    request,
    "PATCH",
    `spaces/${library.id}/sidebar-pin`,
    { pinned: true },
    account,
  );
  await api(
    request,
    "POST",
    `documents/${note.id}/import`,
    {
      markdown: base.markdown.replace(
        "\n<!-- /anote:block -->",
        "团队协作约定：笔记、目录和评论。\n<!-- /anote:block -->",
      ),
      opId: randomUUID(),
    },
    account,
  );
  const directory = path.resolve(
    "artifacts/desktop/packaged-profiles",
    randomUUID(),
  );
  const sibling=await api(request,"POST","documents",{space_id:library.id,title:"客户端同库切换笔记"},account);
  await fs.mkdir(directory, { recursive: true });
  const application = await _electron.launch({
    executablePath: path.resolve(
      "artifacts/releases/ANote-linux-x64/ANote",
    ),
    args: ["--no-sandbox"],
    env: {
      ...process.env,
      ANOTE_LOCALE: "zh-CN",
      ANOTE_CLIENT_DATA_DIR: directory,
      ANOTE_DESKTOP_TEST: "0",
    },
  });
  try {
    const info = await application.evaluate(({ app, BrowserWindow }) => {
      const prefs =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        applicationName: app.getName(),
        packaged: app.isPackaged,
        appPath: app.getAppPath(),
        sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation,
        nodeIntegration: prefs.nodeIntegration,
      };
    });
    expect(info.packaged).toBe(true);
    expect(info.applicationName).toBe("ANote");
    expect(info.appPath).toContain("app.asar");
    expect(info.sandbox).toBe(true);
    expect(info.contextIsolation).toBe(true);
    expect(info.nodeIntegration).toBe(false);
    const page = await application.firstWindow();
    const openMainNote = page.locator(".note-open").filter({has:page.locator("strong",{hasText:title})});
    await page.getByRole("button", { name: "连接团队空间", exact: true }).click();
    await expect(page.getByLabel("服务地址", { exact: true })).toHaveValue(
      process.env.DESKTOP_DEFAULT_SERVER_URL || "",
    );
    await page.getByLabel("服务地址", { exact: true }).fill(origin);
    await page
      .getByLabel("用户名", { exact: true })
      .fill(process.env.ADMIN_USERNAME!);
    await page
      .getByLabel("密码", { exact: true })
      .fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "连接研究空间 →" }).click();
    await expect(
      openMainNote,
    ).toBeVisible();
    const geometry=await uiGeometry(page);
    expect(geometry).toEqual(JSON.parse(await fs.readFile("artifacts/web/ui-geometry-web.json","utf8")));
    await fs.writeFile("artifacts/desktop/ui-geometry-native.json",JSON.stringify(geometry,null,2));
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      (window as any).__metadataRequests = 0;
      window.fetch = async (input, options) => {
        const value =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (
          /^\/api\/documents\/[\w-]+$/.test(
            new URL(value, location.href).pathname,
          )
        ) {
          if (++(window as any).__metadataRequests === 1)
            throw new TypeError("Simulated temporary connection loss");
        }
        return original(input, options);
      };
    });
    await openMainNote.click();
    await expect(page.getByTestId("editor")).toContainText("团队协作约定");
    expect(
      await page.evaluate(() => (window as any).__metadataRequests),
    ).toBeGreaterThan(1);
    await expect(page.getByTestId("document-sync")).toHaveText("已同步");
    expect(await page.evaluate(() => typeof window.__anoteTest)).toBe(
      "undefined",
    );
    await page
      .locator(".academic-sidebar-heading")
      .getByRole("button", { name: "收起侧边栏", exact: true })
      .click();
    const expandSidebar = page.getByRole("button", {
      name: "展开侧边栏",
      exact: true,
    });
    expect((await expandSidebar.boundingBox())!.y).toBeLessThan(80);
    await page.getByRole('button',{name:'返回知识库',exact:true}).click();
    await expect(expandSidebar).toBeVisible();
    await openMainNote.click();
    await expect(page.getByTestId('editor')).toContainText('团队协作约定');
    await expect(expandSidebar).toBeVisible();
    await expandSidebar.click();
    await expect(page.getByTestId("editor")).toContainText("团队协作约定");
    const noteList=page.getByRole("complementary",{name:"同库笔记",exact:true});
    await noteList.getByRole("navigation",{name:"知识库笔记列表",exact:true}).getByRole("button",{name:sibling.title,exact:true}).click();
    await expect(page.getByLabel("笔记标题",{exact:true})).toHaveValue(sibling.title);
    await noteList.getByRole("navigation",{name:"知识库笔记列表",exact:true}).getByRole("button",{name:title,exact:true}).click();
    await expect(page.getByTestId("editor")).toContainText("团队协作约定");
    await noteList.getByRole("button",{name:"隐藏笔记列表",exact:true}).click();
    await page.getByRole("button",{name:"返回知识库",exact:true}).click();
    await openMainNote.click();
    await expect(noteList.getByRole("button",{name:"显示笔记列表",exact:true})).toBeVisible();
    const paragraph = page.getByTestId("editor").locator(":scope > p").first();
    await paragraph.click();
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const formats = page.getByRole("toolbar", { name: "选区格式" });
    await formats.getByRole("button", { name: "字号", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "20 px", exact: true }),
    ).toBeVisible();
    await formats
      .getByRole("button", { name: "文字颜色", exact: true })
      .click();
    await expect(page.locator(".color-swatch")).toHaveCount(8);
    await paragraph.click();
    await page.locator(".document-actions").getByRole("button", {name:"阅读",exact:true}).click();
    await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","false");
    await expect(page.getByLabel("笔记标题",{exact:true})).toHaveJSProperty("readOnly",true);
    await page.locator(".document-actions").getByRole("button", {name:"编辑",exact:true}).click();
    await expect(page.getByTestId("editor")).toHaveAttribute("contenteditable","true");
    const state = await page.evaluate(() => window.anote.state());
    await page
      .locator(".document-actions")
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "正文评论" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /审核流程|提交审核|查看审核快照/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page
      .locator(".academic-user")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    const appearance = page.getByRole("dialog", { name: "设置", exact: true });
    await chooseTheme(page, "dark");
    await appearance.getByLabel("昵称", { exact: true }).fill("桌面昵称验证");
    await appearance.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(appearance.locator(".profile-card h3")).toHaveText("桌面昵称验证");
    await expect.poll(async () => (await page.evaluate(() => window.anote.state())).user?.name).toBe("桌面昵称验证");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("button", { name: "外观模式", exact: true })).toHaveAttribute("aria-busy", "false");
    await appearance.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    await expect(page.getByTestId("editor")).toContainText("团队协作约定");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".document-actions").getByRole("button", { name: "历史版本", exact: true }).click();
    const historyPanel = page.getByRole("complementary", { name: "历史版本", exact: true });
    await expect(historyPanel.locator(".note-panel-header strong")).toHaveText("历史版本");
    await expect(historyPanel.getByRole("button", { name: /^(评论|本地同步)$/ })).toHaveCount(0);
    await expect(page.locator(".inspector-tabs")).toHaveCount(0);
    await page.screenshot({ path: "artifacts/desktop/note-panel-history-dark.png", animations: "disabled" });
    await historyPanel.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await page.getByRole("button", { name: "笔记更多操作", exact: true }).click();
    await page.locator(".note-more").getByRole("button", { name: "本地同步", exact: true }).click();
    const syncPanel = page.getByRole("complementary", { name: "本地同步", exact: true });
    await expect(syncPanel.locator(".note-panel-header strong")).toHaveText("本地同步");
    await expect(syncPanel.getByRole("button", { name: /^(评论|历史版本)$/ })).toHaveCount(0);
    await expect(page.locator(".inspector")).toHaveCount(1);
    await page.screenshot({ path: "artifacts/desktop/note-panel-sync-dark.png", animations: "disabled" });
    await syncPanel.getByRole("button", { name: "收起侧栏", exact: true }).click();
    await api(request, "PATCH", "me/preferences", { theme: "light" }, account);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page
      .locator(".academic-user")
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await chooseTheme(page, "light");
    await appearance.getByLabel("昵称", { exact: true }).fill(account.user.name);
    await appearance.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(appearance.locator(".profile-card h3")).toHaveText(account.user.name);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("button", { name: "外观模式", exact: true })).toHaveAttribute("aria-busy", "false");
    await appearance.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("button", { name: "显示文内目录", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "文内目录" }),
    ).toContainText("H1–H5");
    await page
      .getByRole("complementary", { name: "文内目录" })
      .getByRole("button", { name: "隐藏文内目录" })
      .click();
    await expect(
      page
        .locator(".academic-sidebar .sidebar-library")
        .filter({ hasText: title }),
    ).toContainText(title);
    await page.locator('.academic-sidebar').getByRole('button',{name:'取消固定 '+title,exact:true}).click();
    await expect(page.locator('.academic-sidebar .sidebar-library').filter({hasText:title})).toBeVisible();
    await expect(page.locator('.academic-sidebar').getByRole('button',{name:'固定到侧栏 '+title,exact:true})).toHaveAttribute('aria-pressed','false');
    await expect(
      page.locator(
        ".academic-sidebar .catalog-tree,.academic-sidebar .catalog-note",
      ),
    ).toHaveCount(0);
    await page.screenshot({
      path: "artifacts/desktop/packaged-linux.png",
      fullPage: true,
    });
    const inviteTeam = await api(request,"POST","teams",{name:"桌面邀请复制 "+randomUUID().slice(0,6)},account);
    await page.locator(".academic-navigation").getByRole("button",{name:/^我的团队/}).click();
    await page.locator(".team-directory .team-card").filter({hasText:inviteTeam.name}).click();
    await page.getByRole("button",{name:"成员",exact:true}).click();
    const inviteForm=page.locator(".invite-member-inline");await inviteForm.getByRole("button",{name:"生成邀请链接",exact:true}).click();await expect(inviteForm.getByLabel("团队邀请链接",{exact:true})).toHaveValue(/invite=/);await inviteForm.getByRole("button",{name:"复制邀请链接",exact:true}).click();await expect(inviteForm.getByRole("button",{name:"已复制",exact:true})).toBeVisible();
    expect(await application.evaluate(({clipboard})=>clipboard.readText())).toBe(await inviteForm.getByLabel("团队邀请链接",{exact:true}).inputValue());
    await page.evaluate(() => window.anote.logout());
    const res = await fetch(state.serverURL + "/api/me", {
      headers: { Authorization: "Bearer " + state.token },
    });
    expect(res.status).toBe(401);
    await fs.writeFile(
      "artifacts/releases/linux-runtime-evidence.json",
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          ...info,
          apiLogin: true,
          serverOrigin: new URL(origin).origin,
          isolatedFixture: true,
          sessionRevoked: true,
          debugHookAbsent: true,
          inlineFormatting: true,
          marginAnnotations: true,
          commentsOnly: true,
          themeSwitch: true,
          nicknameSavedAndNativeStateUpdated: true,
          themeReloadAndAccountRefresh: true,
          outlineToggle: true,
          libraryNavigation: true,
          sidebarPinnedAndRecentLibraries: true,
          sidebarToggleAtBrand: true,
          sidebarHiddenAcrossNavigation: true,
          libraryNoteListSwitchAndIndependentCollapse: true,
          uiGeometryMatchesWeb: true,
          invitationSystemClipboardVerified: true,
          scope:
            "Real packaged Linux Electron in Docker/Xvfb; root harness uses --no-sandbox; native Windows/macOS pending",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await application.close();
  }
});
