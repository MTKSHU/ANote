import { test, expect } from "@playwright/test";
test("客户端下载入口要求登录，构建未挂载时显示明确状态", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/client-releases")).status()).toBe(401);
  await page.goto("/");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(process.env.ADMIN_USERNAME!);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "桌面客户端", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "桌面客户端", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "客户端构建正在准备", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});
