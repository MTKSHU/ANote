import { expect, type Page, type APIRequestContext, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
export async function editMapNode(map:Locator,index:number,text:string) {
  const node=map.locator('.mind-map-node').nth(index);
  if(!await node.locator('input').count())await node.dblclick();
  await node.locator('input').fill(text);await node.locator('input').press('Escape');
  await expect(node.locator('.mind-map-node-label')).toHaveText(text);
}
export async function uiGeometry(page: Page) {
  return page.evaluate(() => {
    const style=(selector:string)=>getComputedStyle(document.querySelector(selector)!);
    return {font:style("body").fontFamily,headingSize:style(".academic-page-header h1").fontSize,headingWeight:style(".academic-page-header h1").fontWeight,headingColor:style(".academic-page-header h1").color,
      actionHeight:document.querySelector(".academic-page-actions .primary")!.getBoundingClientRect().height,actionFont:style(".academic-page-actions .primary").fontSize,actionRadius:style(".academic-page-actions .primary").borderRadius,
      tabHeight:style(".home-tabs button").height,tabFont:style(".home-tabs button").fontSize,tabBackground:style(".home-tabs button").backgroundColor};
  });
}
export async function chooseTheme(page: Page, theme: "light" | "dark" | "auto") {
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  const reopen = await settings.isVisible();
  const tab = reopen ? await settings.locator(":scope > nav button.active").innerText() : "";
  if (reopen) await settings.locator(":scope > header").getByRole("button", { name: "关闭", exact: true }).click();
  if (await page.locator("html").getAttribute("data-theme-mode") !== theme) {
    await page.getByRole("button", { name: "外观模式", exact: true }).click();
    await page.getByRole("menuitemradio", {name:new RegExp("^"+theme[0].toUpperCase()+theme.slice(1))}).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", theme);
  const resolved=theme === "auto" ? await page.evaluate(()=>matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light") : theme;
  await expect(page.locator("html")).toHaveAttribute("data-theme", resolved);
  if (reopen) {
    await openWorkspaceSettings(page);
    if (tab && tab !== "账号与偏好") await settings.getByRole("button", { name: tab, exact: true }).click();
  }
}
export async function openWorkspaceSettings(page: Page) {
  const settings=page.getByRole("dialog",{name:"设置",exact:true});
  if(await settings.isVisible())return settings;
  const menu=page.locator(".workspace-account-menu");
  if(await menu.getAttribute("open")===null)await menu.locator("summary").click();
  await page.getByRole("menuitem",{name:"设置",exact:true}).click();
  await expect(settings).toBeVisible();
  return settings;
}
export async function signOutWorkspace(page: Page) {
  const menu=page.locator(".workspace-account-menu");
  if(await menu.getAttribute("open")===null)await menu.locator("summary").click();
  await page.getByRole("menuitem",{name:/^(退出登录|关闭个人模式)$/}).click();
}
const localAccounts = new Map<string, { username: string; password: string }>();
export async function openWorkspaceSwitcher(page:Page) {
  const menu=page.locator(".workspace-account-menu");
  if(await menu.getAttribute("open")===null)await menu.getByRole("button",{name:"用户菜单",exact:true}).click();
  const trigger=page.getByRole("menuitem",{name:"工作空间切换",exact:true});
  if(await trigger.getAttribute("aria-expanded")!=="true")await trigger.click();
  const choices=page.getByRole("menu",{name:"工作空间切换",exact:true});
  await expect(choices).toBeVisible();return choices;
}
export async function switchWorkspace(page:Page,name:string) {
  const choices=await openWorkspaceSwitcher(page);
  await choices.getByRole("menuitemradio",{name,exact:true}).click();
}
export async function accountMenu(page:Page,item:"好友"|"团队管理"|"全部知识库") {
  if(item!=="好友"){const link=page.getByRole("navigation",{name:"知识库导航",exact:true}).getByRole("link",{name:item,exact:true});if(await link.count()){await link.click();return;}}
  const menu=page.locator(".workspace-account-menu");
  if(await menu.getAttribute("open")===null)await menu.getByRole("button",{name:"用户菜单",exact:true}).click();
  await page.getByRole("menu",{name:"用户菜单",exact:true}).getByRole("menuitem",{name:new RegExp("^"+item)}).click();
}
export async function api(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: any,
  account?: any,
  status?: number,
) {
  // Older collaboration scenarios grant library roles directly. Set up the now-required
  // team invitation explicitly for those successful fixture grants, preserving negative cases.
  if (
    method === "POST" &&
    /^spaces\/[^/]+\/members$/.test(path) &&
    data?.role &&
    account &&
    !status &&
    localAccounts.has(data.user_id)
  ) {
    const libraries = await request
      .get("/api/spaces", {
        headers: { Authorization: "Bearer " + account.token },
      })
      .then((r) => r.json());
    const library = libraries.find((l: any) => l.id === path.split("/")[1]);
    if (library?.team_id) {
      const team = await request
        .get("/api/teams/" + library.team_id, {
          headers: { Authorization: "Bearer " + account.token },
        })
        .then((r) => r.json());
      if (!team.members.some((m: any) => m.id === data.user_id)) {
        const invitation = await request
          .post(`/api/teams/${library.team_id}/invites`, {
            headers: { Authorization: "Bearer " + account.token },
            data: {},
          })
          .then((r) => r.json());
        const credentials = localAccounts.get(data.user_id)!;
        const signed = await request
          .post("/api/auth/login", { data: credentials })
          .then((r) => r.json());
        const token = new URL(invitation.path, "http://test").searchParams.get(
          "invite",
        );
        const joined = await request.post(
          `/api/team-invitations/${token}/accept`,
          { headers: { Authorization: "Bearer " + signed.token }, data: {} },
        );
        expect(joined.ok()).toBeTruthy();
      }
    }
  }
  const r = await request.fetch("/api/" + path, {
    method,
    ...(data === undefined ? {} : { data }),
    headers: account ? { Authorization: "Bearer " + account.token } : {},
  });
  if (status) expect(r.status(), method + " " + path).toBe(status);
  else expect(r.ok(), method + " " + path).toBeTruthy();
  const result = await r.json();
  if (method === "POST" && path === "users" && r.ok() && data?.password)
    localAccounts.set(result.id, {
      username: data.username,
      password: data.password,
    });
  return result;
}
export async function admin(request: APIRequestContext) {
  return api(request, "POST", "auth/login", {
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  });
}
export async function removeEmptyDefaultLibrary(request: APIRequestContext, account: any) {
  for (const library of await api(request,"GET","spaces",undefined,account))
    if (library.kind === "personal" && library.created_by === account.user.id && library.name === "默认知识库" && library.note_count === 0)
      await api(request,"DELETE",`spaces/${library.id}`,undefined,account);
}
export async function login(page: Page, account: any = {}) {
  await page.goto("/");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(account.username || process.env.ADMIN_USERNAME!);
  await page
    .getByLabel("密码", { exact: true })
    .fill(account.password || process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".academic-workspace")).toBeVisible();
}
export async function createLibrary(
  page: Page,
  name = "研究资料 " + randomUUID().slice(0, 6),
  kind = "personal",
) {
  if(kind === "personal") await accountMenu(page,"全部知识库");
  else await page.locator(".academic-team-libraries").getByRole("button",{name:/团队$/}).first().click();
  if (kind === "team")
    await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page.getByRole("button", { name: "新建知识库", exact: true }).click();
  const d = page.getByRole("dialog", { name: "新建知识库" });
  await d.getByLabel("名称", { exact: true }).fill(name);
  await d.getByLabel("简介", { exact: true }).fill("研究笔记、实验记录与资料");
  await d.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".academic-page-header h1")).toHaveText(name);
  return new URL(page.url()).searchParams.get("space")!;
}
export async function createNote(
  page: Page,
  title = "研究笔记 " + randomUUID().slice(0, 5),
) {
  if (await page.getByTestId("editor").count())
    await page
      .locator(".document-header")
      .getByRole("button", { name: "返回知识库", exact: true })
      .click();
  await page
    .locator(".academic-page-actions")
    .getByRole("button", { name: "新建笔记", exact: true })
    .click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await page.getByLabel("笔记标题", { exact: true }).fill(title);
  await page.getByLabel("笔记标题", { exact: true }).press("Tab");
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
  return new URL(page.url()).searchParams.get("doc")!;
}
export async function typeBody(page: Page, text: string) {
  await page.getByTestId("editor").locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(text);
  await expect(page.getByTestId("document-sync")).toHaveText("已同步");
}
export async function slash(page: Page, label: string, query = label) {
  await page.getByTestId("editor").locator(":scope > p").last().click();
  await page.keyboard.press("End");
  if((await page.getByTestId("editor").locator(":scope > p").last().textContent())?.length)await page.keyboard.press("Enter");
  await page.keyboard.insertText("/" + query);
  const menu = page.getByRole("listbox", { name: "插入内容" });
  await expect(menu).toBeVisible();
  await menu.getByRole("option", { name: label, exact: false }).first().click();
}
export async function selectText(
  page: Page,
  selector = ":scope > p",
  index = 0,
) {
  const node = page
    .getByTestId("editor")
    .locator(selector)
    .filter({ hasText: /\S/ })
    .nth(index);
  await node.click();
  await node.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}
