import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readVersionInfo, releaseEditorSchema } from "../src/version-info.js";

async function files(run: (index: string, manifest: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anote-version-"));
  try {
    await run(path.join(directory, "index.html"), path.join(directory, "manifest.json"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("版本信息使用实际网页入口，只公开构建、schema 与客户端版本", async () => {
  await files(async (index, manifest) => {
    await fs.writeFile(index, '<html><script type="module" crossorigin src="/assets/index-CEkahyTN.js"></script></html>');
    await fs.writeFile(manifest, JSON.stringify({
      version: "0.4.13", packages: [{ file: "private.zip", directory: "/private/path" }],
      secret: "not-public", nativeAcceptance: { private: "details" },
    }));
    assert.deepEqual(await readVersionInfo(index, manifest, 8), {
      build_id: "CEkahyTN", web_entry: "/assets/index-CEkahyTN.js", editor_schema: 8, desktop_version: "0.4.13",
    });
    await fs.writeFile(index, "<script src='/assets/index-next_123.js' type='module'></script>");
    assert.equal((await readVersionInfo(index, manifest, 8)).build_id, "next_123");
  });
});

test("构建与发布元数据暂缺时返回空版本，拒绝非法入口和非版本内容", async () => {
  await files(async (index, manifest) => {
    assert.deepEqual(await readVersionInfo(index, manifest, 8), {
      build_id: null, web_entry: null, editor_schema: 8, desktop_version: null,
    });
    for (const source of [
      '<script type="module" src="https://other.example/assets/index-abcdefgh.js"></script>',
      '<script type="module" src="/assets/index-../../private.js"></script>',
      '<script src="/assets/index-abcdefgh.js"></script>',
      '<script data-type="module" src="/assets/index-abcdefgh.js"></script>',
      '<script type="module" data-src="/assets/index-abcdefgh.js"></script>',
      '<script>const src="/assets/index-abcdefgh.js"</script>',
    ]) {
      await fs.writeFile(index, source);
      await fs.writeFile(manifest, JSON.stringify({ version: "/private/path" }));
      assert.equal((await readVersionInfo(index, manifest, 8)).web_entry, null);
      assert.equal((await readVersionInfo(index, manifest, 8)).desktop_version, null);
    }
    await fs.writeFile(manifest, "{incomplete");
    assert.equal((await readVersionInfo(index, manifest, 8)).desktop_version, null);
  });
});

test("发布 schema 仅接受正安全整数，旧发布保持空值", () => {
  assert.equal(releaseEditorSchema(8), 8);
  for (const value of [undefined, null, "8", -1, 0, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(releaseEditorSchema(value), null);
});
