import { test } from "node:test";
import assert from "node:assert/strict";
import { saveBeforeReload } from "../../apps/web/src/update-reload.js";

test("保存等待期间继续输入时，再保存一轮后才允许刷新", async () => {
  const events = new EventTarget();
  let calls = 0;
  await saveBeforeReload(async () => {
    calls++;
    if (calls === 1) events.dispatchEvent(new Event("input"));
  }, events);
  assert.equal(calls, 2);
});

test("无新交互只保存一次，失败直接传递并保留页面", async () => {
  let calls = 0;
  await saveBeforeReload(async () => { calls++; }, new EventTarget());
  assert.equal(calls, 1);
  const error = new Error("标题保存失败");
  await assert.rejects(saveBeforeReload(async () => { throw error; }, new EventTarget()), error);
});
