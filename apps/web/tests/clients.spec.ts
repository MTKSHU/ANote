import {openWorkspaceSettings} from "./helpers";
import { test, expect } from "@playwright/test";
test("客户端下载入口要求登录，构建未挂载时显示明确状态", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/client-releases")).status()).toBe(401);
  await page.route("**/api/client-releases?brand=ANote", route => route.fulfill({ json: { version: null, signed: false, packages: [] } }));
  await page.goto("/");
  await page
    .getByLabel("用户名", { exact: true })
    .fill(process.env.ADMIN_USERNAME!);
  await page
    .getByLabel("密码", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录" }).click();
  await openWorkspaceSettings(page);
  await page.getByRole("button", { name: "桌面客户端", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "桌面客户端", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "客户端构建正在准备", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
});

test("网页客户端下载明确请求 ANote 渠道，旧 updater 桥接包不混入下载表", async ({ page, request }) => {
  expect((await request.get("/api/client-releases?brand=ANote")).status()).toBe(401);
  const requests: string[] = [];
  await page.route("**/api/client-releases**", route => {
    if (new URL(route.request().url()).pathname === "/api/client-releases/mobile") return route.fulfill({ json: { packages: [] } });
    const brand = new URL(route.request().url()).searchParams.get("brand");
    requests.push(brand || "legacy");
    const name = brand === "ANote" ? "ANote" : "SimpleNote";
    const file = `${name}-0.4.14-linux-x64.tar.gz`;
    return route.fulfill({ json: { version: "0.4.14", signed: false, packages: [{ platform: "linux", arch: "x64", file, bytes: 128_000_000, sha256: "a".repeat(64), url: "/api/client-releases/" + file }] } });
  });
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill(process.env.ADMIN_USERNAME!);
  await page.getByLabel("密码", { exact: true }).fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await openWorkspaceSettings(page);
  await page.getByRole("button", { name: "桌面客户端", exact: true }).click();
  const table = page.getByRole("table", { name: "桌面客户端下载", exact: true });
  await expect(table).toContainText("ANote-0.4.14-linux-x64.tar.gz");
  await expect(table).not.toContainText("SimpleNote-");
  await expect(table.getByRole("link", { name: "下载 ANote-0.4.14-linux-x64.tar.gz", exact: true })).toHaveAttribute("download", "ANote-0.4.14-linux-x64.tar.gz");
  expect(requests).toEqual(["ANote"]);
});
