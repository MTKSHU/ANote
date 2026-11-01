import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { api, admin, login, createNote, typeBody, chooseTheme } from "./helpers";
const password = "Appearance-trash-test-123!";
async function person(request: APIRequestContext, root: any) {
  const username = "appearance-" + randomUUID().slice(0, 8),
    user = await api(
      request,
      "POST",
      "users",
      { username, name: "外观测试用户", password },
      root,
    );
  return {
    ...(await api(request, "POST", "auth/login", { username, password })),
    id: user.id,
    username,
    password,
  };
}
async function fixture(request: APIRequestContext) {
  const root = await admin(request),
    owner = await person(request, root),
    book = await api(
      request,
      "POST",
      "spaces",
      { name: "外观与回收站", kind: "personal" },
      owner,
    ),
    note = await api(
      request,
      "POST",
      "documents",
      { space_id: book.id, title: "彻底删除校验" },
      owner,
    );
  return { root, owner, book, note };
}
async function trash(
  request: APIRequestContext,
  account: any,
  kind: string,
  id: string,
) {
  await api(request, "DELETE", `${kind}/${id}`, undefined, account);
  return (await api(request, "GET", `trash/${kind}`, undefined, account)).find(
    (item: any) => item.id === id,
  );
}
test("彻底删除验证管理权限、恢复后的旧状态及父级清理", async ({ request }) => {
  const { root, owner, book, note } = await fixture(request);
  let deleted = await trash(request, owner, "documents", note.id);
  expect(
    new Date(deleted.expires_at).getTime() -
      new Date(deleted.deleted_at).getTime(),
  ).toBe(30 * 86400000);
  await api(
    request,
    "DELETE",
    `trash/documents/${note.id}`,
    { deletion_token: deleted.trash_batch },
    root,
    403,
  );
  await api(
    request,
    "DELETE",
    `trash/documents/${note.id}`,
    { deletion_token: "stale" },
    owner,
    409,
  );
  await api(request, "POST", `documents/${note.id}/restore-deleted`, {}, owner);
  await api(
    request,
    "DELETE",
    `trash/documents/${note.id}`,
    { deletion_token: deleted.trash_batch },
    owner,
    409,
  );
  const again = await trash(request, owner, "documents", note.id);
  expect(again.trash_batch).not.toBe(deleted.trash_batch);
  await api(
    request,
    "DELETE",
    `trash/documents/${note.id}`,
    { deletion_token: deleted.trash_batch },
    owner,
    409,
  );
  await api(
    request,
    "DELETE",
    `trash/documents/${note.id}`,
    { deletion_token: again.trash_batch },
    owner,
  );
  await api(request, "GET", `documents/${note.id}`, undefined, owner, 404);
  await api(
    request,
    "POST",
    `documents/${note.id}/restore-deleted`,
    {},
    owner,
    404,
  );
  const remaining = await api(
    request,
    "POST",
    "documents",
    { space_id: book.id, title: "随知识库删除" },
    owner,
  );
  deleted = await trash(request, owner, "spaces", book.id);
  await api(
    request,
    "DELETE",
    `trash/spaces/${book.id}`,
    { deletion_token: deleted.trash_batch },
    owner,
  );
  await api(request, "GET", `documents/${remaining.id}`, undefined, owner, 404);
  const team = await api(
      request,
      "POST",
      "teams",
      { name: "永久清理团队" },
      owner,
    ),
    teamBook = await api(
      request,
      "POST",
      "spaces",
      { name: "团队库", kind: "team", team_id: team.id },
      owner,
    ),
    teamNote = await api(
      request,
      "POST",
      "documents",
      { space_id: teamBook.id, title: "团队笔记" },
      owner,
    );
  deleted = await trash(request, owner, "teams", team.id);
  await api(
    request,
    "DELETE",
    `trash/teams/${team.id}`,
    { deletion_token: deleted.trash_batch },
    owner,
  );
  expect(
    (await api(request, "GET", "teams", undefined, owner)).some(
      (item: any) => item.id === team.id,
    ),
  ).toBe(false);
  await api(request, "GET", `documents/${teamNote.id}`, undefined, owner, 404);
});
test("主题偏好仅修改本人，拒绝无效值且新会话可读取保存结果", async ({
  request,
}) => {
  const root = await admin(request),
    owner = await person(request, root),
    other = await person(request, root);
  await api(
    request,
    "PATCH",
    "me/preferences",
    { theme: "unknown" },
    owner,
    400,
  );
  await api(
    request,
    "PATCH",
    "me/preferences",
    { theme: "dark", user_id: other.id },
    owner,
  );
  expect((await api(request, "GET", "me", undefined, other)).theme).toBe(
    "auto",
  );
  const signed = await api(request, "POST", "auth/login", {
    username: owner.username,
    password,
  });
  expect(signed.user.theme).toBe("dark");
  await api(request, "PATCH", "me/preferences", { theme: "light" }, owner);
});
test("明暗主题即时切换、重开保留；回收站输入名称确认彻底删除", async ({
  request,
  page,
}) => {
  const { owner, note } = await fixture(request);
  await login(page, owner);
  await page.goto("/?doc=" + note.id);
  const editor = page.getByTestId("editor");
  await expect(editor).toBeVisible();
  await typeBody(page, "主题切换保留当前编辑正文");
  await editor.evaluate((el) => (el.dataset.appearanceCheck = "retained"));
  await page
    .getByLabel("上传附件文件", { exact: true })
    .setInputFiles("artifacts/server/fixtures/sample.png");
  const image = page.locator(".media-resource img");
  await expect(image).toHaveJSProperty("naturalWidth", 64);
  await image.scrollIntoViewIfNeeded();
  const capture = async () => {
    const box = (await image.boundingBox())!;
    return page.screenshot({
      clip: {
        x: Math.round(box.x) + 8,
        y: Math.round(box.y) + 8,
        width: 32,
        height: 32,
      },
    });
  };
  const original = await capture();
  await page
    .locator(".academic-user")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await chooseTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "外观模式", exact: true }),
  ).toHaveAttribute("title", /Dark/);
  await expect(editor).toHaveAttribute("data-appearance-check", "retained");
  await expect
    .poll(async () => (await api(request, "GET", "me", undefined, owner)).theme)
    .toBe("dark");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  const contrast = await editor.evaluate((el) => {
    const fg = getComputedStyle(el).color.match(/\d+/g)!.map(Number),
      bg = getComputedStyle(el.closest(".paper")!)
        .backgroundColor.match(/\d+/g)!
        .map(Number);
    const lum = (v: number[]) =>
      v
        .slice(0, 3)
        .map((n) => {
          n /= 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    return (
      (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05)
    );
  });
  expect(contrast).toBeGreaterThan(4.5);
  await image.scrollIntoViewIfNeeded();
  expect((await capture()).equals(original), "主题切换不得改变图片颜色").toBe(
    true,
  );
  await page.screenshot({ path: "artifacts/web/academic-dark-editor.png" });
  await page.reload();
  await expect(editor).toContainText("主题切换保留当前编辑正文");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "笔记更多操作" }).click();
  await page.getByRole("button", { name: "删除笔记", exact: true }).click();
  await page
    .getByRole("dialog", { name: "确认删除" })
    .getByRole("button", { name: "移入回收站", exact: true })
    .click();
  await page
    .locator(".academic-navigation")
    .getByRole("button", { name: /回收站/ })
    .click();
  const row = page.locator(".trash-row").filter({ hasText: note.title });
  await expect(row).toContainText("还剩 30 天");
  await row
    .getByRole("button", { name: "彻底删除笔记 " + note.title, exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: "确认彻底删除" });
  await expect(
    confirmation.getByRole("button", { name: "确认彻底删除", exact: true }),
  ).toBeDisabled();
  await confirmation.getByLabel("输入名称确认彻底删除").fill(note.title);
  await page.screenshot({ path: "artifacts/web/academic-dark-trash.png" });
  await confirmation
    .getByRole("button", { name: "确认彻底删除", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page
    .locator(".academic-user")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await chooseTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(async () => (await api(request, "GET", "me", undefined, owner)).theme)
    .toBe("light");
});
