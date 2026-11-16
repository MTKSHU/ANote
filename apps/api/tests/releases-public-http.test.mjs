import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {NestFactory} from "@nestjs/core";

// Exercise the compiled real Nest controller on loopback. No database, external
// service, production environment file or genuine release package is needed.
test("匿名更新检查可发现版本，但完整清单与实际包始终要求登录",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"anote-release-check-http-")),previous=process.env.DESKTOP_RELEASE_DIR;
  process.env.DESKTOP_RELEASE_DIR=directory;
  const binary=Buffer.from("private-package-bytes"),sha256=createHash("sha256").update(binary).digest("hex"),version="0.4.99";
  const pkg=(platform,arch,brand="ANote")=>({platform,arch,file:`${brand}-${version}-${platform}-${arch}.${platform==="win32"?"zip":"tar.gz"}`,bytes:binary.length,sha256,directory:"/private/build/output",token:"private-token",url:"https://private.example/package"});
  const arm=pkg("darwin","arm64"),legacy=pkg("darwin","arm64","SimpleNote"),manifest={version,editorSchema:8,signed:false,packages:[arm,pkg("linux","x64")],legacyPackages:[legacy],electron:"private-electron",nativeAcceptance:{private:"private-machine"},buildHash:"private-build",auth:{secret:"private-secret"}};
  await fs.writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest));for(const item of [...manifest.packages,...manifest.legacyPackages])await fs.writeFile(path.join(directory,item.file),binary);
  const {ReleasesModule}=await import("../dist/releases.js"),{db}=await import("../dist/database.js"),app=await NestFactory.create(ReleasesModule,{logger:false});
  await app.listen(0,"127.0.0.1");const origin=await app.getUrl();
  t.after(async()=>{await app.close();await db.end();await fs.rm(directory,{recursive:true,force:true});if(previous===undefined)delete process.env.DESKTOP_RELEASE_DIR;else process.env.DESKTOP_RELEASE_DIR=previous;});
  const get=url=>fetch(origin+url,{redirect:"error"});
  const check="/api/client-releases/check?brand=ANote&platform=darwin&arch=arm64",response=await get(check);assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  const result=await response.json();assert.deepEqual(result,{version,editor_schema:8,signed:false,requires_auth:true,packages:[{platform:"darwin",arch:"arm64",file:arm.file,bytes:binary.length,sha256,url:"/api/client-releases/"+arm.file}]});assert.equal(JSON.stringify(result).includes("private"),false);
  const historical=await get("/api/client-releases/check?platform=darwin&arch=arm64");assert.equal(historical.status,200);assert.equal((await historical.json()).packages[0].file,legacy.file);
  const ignoredCredential=await fetch(origin+check,{headers:{Authorization:"Bearer invalid"}});assert.equal(ignoredCredential.status,200);
  for(const endpoint of ["/api/client-releases","/api/client-releases?brand=ANote","/api/client-releases/"+arm.file,"/api/client-releases/"+legacy.file]){const protectedResponse=await get(endpoint);assert.equal(protectedResponse.status,401,endpoint);assert.equal((await protectedResponse.text()).includes(binary.toString()),false);}
  for(const [query,status] of [["platform=linux&arch=arm64",400],["platform=darwin&arch=aarch64",400],["platform=win32&arch=x64&brand=ANote",404],["platform=darwin&arch=arm64&brand=other",400],["platform=darwin&platform=linux&arch=x64",400]]){const denied=await get("/api/client-releases/check?"+query);assert.equal(denied.status,status,query);assert.equal(denied.headers.get("cache-control"),"no-store");}
  await fs.writeFile(path.join(directory,"manifest.json"),"{broken");const broken=await get(check);assert.equal(broken.status,503);assert.equal(broken.headers.get("cache-control"),"no-store");assert.equal((await broken.text()).includes(directory),false);
  await fs.unlink(path.join(directory,"manifest.json"));const missing=await get(check);assert.equal(missing.status,200);assert.deepEqual(await missing.json(),{version:null,editor_schema:null,signed:false,requires_auth:true,packages:[]});
});
