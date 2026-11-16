import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {WorkspaceContexts} from "../../apps/desktop/main/workspace-context.mjs";

async function fixture(work){const root=await fs.mkdtemp(path.join(os.tmpdir(),"anote-context-"));try{
  const session={profileKey:"profile-a",dataRoot:root,token:"session-token",settings:{serverURL:"https://a.example",user:{id:"user-a"},offline:false}};
  await fs.mkdir(path.join(root,"offline"));
  await fs.writeFile(path.join(root,"offline/index.json"),JSON.stringify({identity:{serverURL:session.settings.serverURL,userId:"user-a"},teams:[{id:"team-a",name:"Cached team",role:"admin"}]}));
  await work(session);
}finally{await fs.rm(root,{recursive:true,force:true});}}

test("personal-mode workspace hints read the current account cache without network or credentials in the response",()=>fixture(async session=>{
  const contexts=new WorkspaceContexts();let calls=0;
  const value=await contexts.refresh(session,{fetch:async()=>{calls++;throw new Error("must not fetch");}});
  assert.equal(calls,0);assert.deepEqual(value.teams,[{id:"team-a",name:"Cached team",archived:false}]);
  assert.equal(JSON.stringify(value).includes(session.token),false);assert.equal("role" in value.teams[0],false);
}));

test("explicit menu opening refreshes only the configured server with authenticated non-redirecting GET",()=>fixture(async session=>{
  const contexts=new WorkspaceContexts();const value=await contexts.refresh(session,{network:true,fetch:async(url,options)=>{
    assert.equal(url,"https://a.example/api/teams");assert.equal(options.headers.Authorization,"Bearer session-token");assert.equal(options.redirect,"error");
    return Response.json([{id:"team-b",name:"New team",archived:true}]);
  }});assert.deepEqual(value.teams,[{id:"team-b",name:"New team",archived:true}]);
}));

test("another account or server cannot inherit cached team names",()=>fixture(async session=>{
  const contexts=new WorkspaceContexts();await contexts.refresh(session);
  session.profileKey="profile-b";session.settings={...session.settings,user:{id:"user-b"}};
  assert.deepEqual((await contexts.refresh(session)).teams,[]);
  session.profileKey="profile-c";session.settings={...session.settings,serverURL:"https://c.example",user:{id:"user-a"}};
  assert.deepEqual((await contexts.refresh(session)).teams,[]);
}));

test("an in-flight workspace lookup cannot publish the old account after a switch",()=>fixture(async session=>{
  const contexts=new WorkspaceContexts();let finish,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const pending=contexts.refresh(session,{network:true,fetch:()=>{started();return new Promise(resolve=>{finish=resolve;});}});
  await waiting;session.profileKey="profile-b";session.settings={...session.settings,user:{id:"user-b"}};
  finish(Response.json([{id:"private-team",name:"Must not appear"}]));
  await assert.rejects(pending,/账号或服务器已切换/);assert.deepEqual(contexts.get(session).teams,[]);
}));

test("offline and expired-server responses retain only the last account-scoped choices",()=>fixture(async session=>{
  const contexts=new WorkspaceContexts();session.settings.offline=true;
  await contexts.refresh(session,{network:true,fetch:async()=>assert.fail("offline must not fetch")});
  session.settings.offline=false;
  assert.equal((await contexts.refresh(session,{network:true,fetch:async()=>new Response(null,{status:401})})).teams[0].id,"team-a");
  session.profileKey="signed-out";session.settings.user=null;session.token=null;
  assert.deepEqual(contexts.get(session).teams,[]);
}));
