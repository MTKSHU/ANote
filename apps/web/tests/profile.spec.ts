import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { api, admin, login } from "./helpers";

test("昵称仅修改本人显示名称，保存即时生效、重开保留且不改变登录身份", async ({ page, request }) => {
  expect((await request.patch("/api/me/profile", { data: { name: "匿名修改" } })).status()).toBe(401);
  const root = await admin(request), password = "Nickname-test-password-123!";
  async function person() {
    const username = "nickname-" + randomUUID().slice(0, 8);
    await api(request, "POST", "users", { username, password, name: username }, root);
    return { ...await api(request, "POST", "auth/login", { username, password }), username, password };
  }
  const owner = await person(), peer = await person();
  for (const name of ["", "   ", "a".repeat(81), "换\n行", "\u0000名称", null])
    await api(request, "PATCH", "me/profile", { name }, owner, 400);
  const changed = await api(request, "PATCH", "me/profile", { name: "初始昵称", id: peer.user.id, username: "hijack", is_admin: true }, owner);
  expect(changed.id).toBe(owner.user.id);
  expect(changed.username).toBe(owner.username);
  expect(changed.is_admin).toBe(false);
  expect((await api(request, "GET", "me", undefined, peer)).name).toBe(peer.user.name);
  await login(page, owner);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(settings.getByLabel("昵称", { exact: true })).toHaveValue("初始昵称");
  await settings.getByLabel("昵称", { exact: true }).fill("  研究记录者 📝  ");
  await settings.getByRole("button", { name: "保存昵称", exact: true }).click();
  await expect(settings.getByRole("status").filter({ hasText: "昵称已保存" })).toBeVisible();
  await expect(settings.locator(".profile-card h3")).toHaveText("研究记录者 📝");
  await expect(page.locator(".academic-user")).toContainText("研究记录者 📝");
  expect((await api(request, "GET", "me", undefined, owner)).name).toBe("研究记录者 📝");
  await page.reload();
  await expect(page.locator(".academic-user")).toContainText("研究记录者 📝");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings.getByLabel("昵称", { exact: true })).toHaveValue("研究记录者 📝");
  await page.screenshot({ path: "artifacts/web/profile-nickname.png" });
  const relogin = await api(request, "POST", "auth/login", { username: owner.username, password });
  expect(relogin.user.id).toBe(owner.user.id);
  expect(relogin.user.name).toBe("研究记录者 📝");
  expect((await api(request, "GET", "me", undefined, root)).name).toBe(root.user.name);
});
