import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateMobileReleaseManifest, mobileReleaseList, readMobileReleaseManifest } from "../src/mobile-releases.js";
import { validateReleaseManifest, releaseList, releaseCheck } from "../src/release-manifest.js";

const apk = () => ({ platform: "android", kind: "apk", version: "0.5.0-preview", channel: "preview", signing: "test", file: "ANote-0.5.0-android-preview.apk", bytes: 26_869, sha256: "a".repeat(64) });
test("移动清单保留各原生版本/签名边界，只输出同源鉴权下载路径", () => {
  const value = validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: [{ ...apk(), directory: "/private/build", token: "private", url: "https://external.invalid/file.apk" }] });
  assert.deepEqual(value.packages, [apk()]);
  assert.deepEqual(mobileReleaseList(value), { packages: [{ ...apk(), url: "/api/client-releases/mobile/ANote-0.5.0-android-preview.apk" }] });
  const ios = { ...apk(), platform: "ios", kind: "source", version: "0.5.0", signing: "source", file: "ANote-0.5.0-ios-source.tar.gz" };
  assert.deepEqual(validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: [ios] }).packages, [ios]);
});
test("移动白名单拒绝穿越、错误平台/后缀、无效版本和把预览签名冒充正式", () => {
  for (const patch of [{ platform: "linux" }, { platform: "__proto__" }, { file: "ANote-../private.apk" }, { file: "../manifest.json" }, { file: "ANote-client.hap" }, { kind: "source" }, { bytes: 0 }, { bytes: 4 * 1024 ** 3 + 1 }, { sha256: "invalid" }, { version: "latest" }, { version: "00.5.0" }, { channel: "unknown" }, { channel: "stable" }, { signing: "source" }])
    assert.throws(() => validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: [{ ...apk(), ...patch }] }), JSON.stringify(patch));
  assert.throws(() => validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: [apk(), apk()] }));
  assert.throws(() => validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: null }));
  assert.throws(() => validateMobileReleaseManifest({ format: "other", packages: [] }));
});
test("独立移动版本不会进入桌面正常/兼容渠道或任一桌面更新目标", () => {
  const pkg = { platform: "linux", arch: "x64", file: "ANote-0.5.1-linux-x64.tar.gz", bytes: 123, sha256: "b".repeat(64) }, legacy = { ...pkg, file: "SimpleNote-0.5.1-linux-x64.tar.gz" };
  const desktop = validateReleaseManifest({ version: "0.5.1", packages: [pkg], legacyPackages: [legacy] });
  const before = releaseList(desktop, "ANote"), old = releaseList(desktop), check = releaseCheck(desktop, { platform: "linux", arch: "x64", brand: "ANote" });
  mobileReleaseList(validateMobileReleaseManifest({ format: "anote-mobile-releases", packages: [apk()] }));
  assert.deepEqual(releaseList(desktop, "ANote"), before); assert.deepEqual(releaseList(desktop), old);
  assert.deepEqual(releaseCheck(desktop, { platform: "linux", arch: "x64", brand: "ANote" }), check);
  assert.throws(() => releaseCheck(desktop, { platform: "android", arch: "arm64", brand: "ANote" }));
});
test("未挂载移动清单返回空列表，损坏或过大的清单返回不暴露路径的503", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anote-mobile-manifest-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await readMobileReleaseManifest(directory), { format: "anote-mobile-releases", packages: [] });
  for (const data of ["{broken", JSON.stringify({ format: "anote-mobile-releases", packages: [{ ...apk(), file: "../secret" }] }), " ".repeat(128 * 1024 + 1)]) {
    await fs.writeFile(path.join(directory, "manifest.json"), data);
    await assert.rejects(readMobileReleaseManifest(directory), (error: any) => error.getStatus() === 503 && !error.message.includes(directory));
  }
});
