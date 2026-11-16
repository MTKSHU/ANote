import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseList, releasePackage, releasePackages, validateReleaseManifest, releaseCheck, ReleaseCheckError } from "../src/release-manifest.js";

const pkg = (brand = "ANote") => ({ platform: "linux", arch: "x64", file: `${brand}-0.4.14-linux-x64.tar.gz`, bytes: 128_000_000, sha256: "a".repeat(64) });
const manifest = () => ({ version: "0.4.14", editorSchema: 8, packages: [pkg()], legacyPackages: [pkg("SimpleNote")], signed: false });

test("默认为旧 updater 返回桥接包，显式 ANote 请求返回正常新品牌包", () => {
  const value = validateReleaseManifest(manifest());
  assert.equal(releasePackages(value)[0].file, "SimpleNote-0.4.14-linux-x64.tar.gz");
  assert.equal(releasePackages(value, "ANote")[0].file, "ANote-0.4.14-linux-x64.tar.gz");
  assert.equal(releasePackages(value, ["ANote"])[0].file, "SimpleNote-0.4.14-linux-x64.tar.gz");
  assert.equal(releaseList(value).packages.length, 1);
  assert.equal(releaseList(value, "ANote").editor_schema, 8);
});

test("旧 manifest 没有 legacyPackages 时，各渠道保持原有包列表", () => {
  for (const brand of ["ANote", "SimpleNote", "ANote"]) {
    const value = validateReleaseManifest({ version: "0.4.14", packages: [pkg(brand)] });
    assert.deepEqual(releasePackages(value), value.packages);
    assert.deepEqual(releasePackages(value, "ANote"), value.packages);
  }
});

test("下载白名单同时包含正常包与桥接包，未知文件与路径不匹配", () => {
  const value = validateReleaseManifest(manifest());
  assert.equal(releasePackage(value, pkg().file)?.sha256, pkg().sha256);
  assert.equal(releasePackage(value, pkg("SimpleNote").file)?.bytes, pkg().bytes);
  for (const filename of ["ANote-unknown.zip", "../manifest.json", "manifest.json", "ANote-0.4.14-linux-x64.tar.gz"])
    assert.equal(releasePackage(value, filename), undefined);
});

test("包列表仅公开下载字段，不输出本地目录或 legacyPackages", () => {
  const value = validateReleaseManifest({ ...manifest(), packages: [{ ...pkg(), directory: "/private/build", token: "private" }] });
  const result = releaseList(value, "ANote");
  assert.deepEqual(result.packages, [{ ...pkg(), url: "/api/client-releases/ANote-0.4.14-linux-x64.tar.gz" }]);
  assert.equal("legacyPackages" in result, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("两渠道都严格校验，拒绝路径、无效大小/摘要和同名冲突", () => {
  for (const patch of [{ file: "ANote-../../private" }, { file: "Other-client.zip" }, { bytes: 0 }, { bytes: 1.1 }, { sha256: "invalid" }]) {
    assert.throws(() => validateReleaseManifest({ ...manifest(), packages: [{ ...pkg(), ...patch }] }));
    assert.throws(() => validateReleaseManifest({ ...manifest(), legacyPackages: [{ ...pkg("SimpleNote"), ...patch }] }));
  }
  assert.throws(() => validateReleaseManifest({ ...manifest(), legacyPackages: null }));
  assert.throws(() => validateReleaseManifest({ ...manifest(), legacyPackages: [{ ...pkg(), bytes: 1 }] }));
  assert.doesNotThrow(() => validateReleaseManifest({ ...manifest(), legacyPackages: [pkg()] }));
});

test("匿名更新检查只返回单个平台的白名单元数据和认证下载要求", () => {
  const arm={...pkg(),platform:"darwin",arch:"arm64",file:"ANote-0.4.14-darwin-arm64.tar.gz",directory:"/private/path",url:"https://other.example/secret",token:"private-token"};
  const value=validateReleaseManifest({...manifest(),buildHash:"private-build",electron:"private-electron",nativeAcceptance:{private:"internal"},packages:[pkg(),arm]});
  const result=releaseCheck(value,{brand:"ANote",platform:"darwin",arch:"arm64"});
  assert.deepEqual(result,{version:"0.4.14",editor_schema:8,signed:false,requires_auth:true,packages:[{platform:"darwin",arch:"arm64",file:arm.file,bytes:arm.bytes,sha256:arm.sha256,url:"/api/client-releases/"+arm.file}]});
  for(const secret of ["private", "other.example", "legacyPackages", "nativeAcceptance", "electron", "buildHash"])assert.equal(JSON.stringify(result).includes(secret),false,secret);
});

test("匿名更新检查缺省兼容旧渠道，显式ANote选择正式渠道；发布暂缺保持空版本", () => {
  const value=validateReleaseManifest(manifest());
  assert.equal(releaseCheck(value,{platform:"linux",arch:"x64"}).packages[0].file,pkg("SimpleNote").file);
  assert.equal(releaseCheck(value,{brand:"SimpleNote",platform:"linux",arch:"x64"}).packages[0].file,pkg("SimpleNote").file);
  assert.equal(releaseCheck(value,{brand:"ANote",platform:"linux",arch:"x64"}).packages[0].file,pkg().file);
  assert.deepEqual(releaseCheck({version:null,packages:[]},{platform:"darwin",arch:"arm64",brand:"ANote"}),{version:null,editor_schema:null,signed:false,requires_auth:true,packages:[]});
});

test("匿名更新检查明确拒绝不支持平台、数组参数和不存在的平台包", () => {
  const value=validateReleaseManifest(manifest());
  for(const query of [{platform:"linux",arch:"arm64"},{platform:"darwin",arch:"aarch64"},{platform:["linux"],arch:"x64"},{platform:"linux",arch:"x64",brand:["ANote"]},{platform:"linux",arch:"x64",brand:"other"},{}])assert.throws(()=>releaseCheck(value,query),error=>error instanceof ReleaseCheckError&&error.status===400);
  assert.throws(()=>releaseCheck(value,{platform:"darwin",arch:"arm64",brand:"ANote"}),error=>error instanceof ReleaseCheckError&&error.status===404);
});

test("匿名更新检查不公开损坏或不匹配的版本、文件名、大小与多包歧义", () => {
  for(const patch of [{version:"private/version"},{version:"01.4.14"},{version:"0.4.14-beta"},{version:"999999999999999999999.0.0"},{signed:"private-value",version:"invalid"}, {packages:[{...pkg(),file:"ANote-other-linux-x64.tar.gz"}]},{packages:[{...pkg(),bytes:1024**3+1}]},{packages:[pkg(),{...pkg(),file:"SimpleNote-0.4.14-linux-x64.tar.gz"}]}])assert.throws(()=>releaseCheck({...manifest(),...patch} as any,{platform:"linux",arch:"x64",brand:"ANote"}),error=>error instanceof ReleaseCheckError&&error.status===503);
});
