import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
test("应用和 PostgreSQL 重启后从持久化状态恢复，旧同步基准仍有效", async ({
  browser,
  request,
}) => {
  const proof = JSON.parse(
      await fs.readFile("validation/artifacts/restart-proof.json", "utf8"),
    ),
    session = await (
      await request.post("/api/session", {
        data: { user: "alice", secret: process.env.VALIDATION_SECRET },
      })
    ).json(),
    headers = { Authorization: `Bearer ${session.token}` };
  const doc = await (
    await request.get(`/api/documents/${proof.id}`, { headers })
  ).json();
  expect(doc.snapshot).toEqual(proof.snapshot);
  const comments = await (
    await request.get(`/api/documents/${proof.id}/comments`, { headers })
  ).json();
  expect(comments).toHaveLength(1);
  expect(comments[0].resolvedAnchor).toMatchObject({
    text: "场景重建",
    orphaned: false,
  });
  const reviews = await (
    await request.get(`/api/documents/${proof.id}/reviews`, { headers })
  ).json();
  expect(reviews[0]).toMatchObject({
    id: proof.reviewId,
    status: "approved",
    hash: proof.reviewHash,
  });
  const context = await browser.newContext();
  await context.addInitScript(
    (s) => localStorage.setItem("anote-session", JSON.stringify(s)),
    session,
  );
  const page = await context.newPage();
  await page.goto(`/?doc=${proof.id}`);
  await page.waitForFunction(() => !!(window as any).__lab?.editor);
  expect(await page.evaluate(() => (window as any).__lab.getJSON())).toEqual(
    proof.snapshot,
  );
  await expect(page.getByTestId("editor")).toContainText("重启后应完整保留。");
  const imported = await request.post(`/api/documents/${proof.id}/import`, {
    headers,
    data: {
      opId: crypto.randomUUID(),
      markdown: proof.markdown.replace(
        "结论：继续补充实验。",
        "结论：重启后仍可安全回传。",
      ),
    },
  });
  expect(imported.ok()).toBeTruthy();
  await expect(page.getByTestId("editor")).toContainText(
    "重启后仍可安全回传。",
  );
  await page.screenshot({
    path: "validation/artifacts/persistence.png",
    fullPage: true,
  });
  await context.close();
});
