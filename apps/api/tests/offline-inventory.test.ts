import {test} from "node:test";
import assert from "node:assert/strict";
import {inventoryView} from "../src/offline-inventory-view.js";

const library={id:"book",name:"PRIVATE LIBRARY",description:"PRIVATE DESCRIPTION",kind:"personal",team_id:null,catalog_order:["folder:secret","note:private","note:shared"],catalog_revision:"101",role:null};
const note={id:"shared",space_id:"book",folder_id:"secret",title:"Explicitly shared",tags:["research"],role:"editor",archived:false,revision:"3",access_revision:"4",updated_at:"2026-11-06T00:00:00.000Z",asset_versions:[]};
const folder={id:"secret",space_id:"book",parent_id:null,name:"PRIVATE FOLDER",position:0};
const view=(books:any[]=[library],docs:any[]=[note],folders:any[]=[folder])=>inventoryView(books,docs,folders,[],{site_name:"ANote",oidc_secret:"never-public"},8,"2026-11-06T01:00:00.000Z");

test("doc-only invitations expose flat safe shells without parent names, counts or hidden catalog IDs",()=>{
  const result=view(),serialized=JSON.stringify(result);
  assert.equal(result.complete,true);assert.equal(result.schema,8);
  assert.deepEqual(result.libraries,[{id:"book",name:"共享笔记",kind:"personal",team_id:null,role:"viewer",offline_scope:"documents",can_create:false}]);
  assert.deepEqual(result.folders.book,[]);assert.equal(result.documents[0].folder_id,null);assert.equal(result.documents[0].role,"editor");assert.equal(result.documents[0].can_edit,true);
  assert.deepEqual(result.catalogs.book.items,[{key:"note:shared",kind:"note",id:"shared",parent_id:null}]);
  for(const secret of ["PRIVATE LIBRARY","PRIVATE DESCRIPTION","PRIVATE FOLDER","note:private","folder:secret","never-public"])assert.equal(serialized.includes(secret),false,secret);
});

test("library viewers retain their authorized folder view while exact document roles control editability",()=>{
  const result=view([{...library,role:"viewer"}],[{...note,role:"viewer"},{...note,id:"editor-grant",role:"editor"}]);
  assert.equal(result.libraries[0].offline_scope,"library");assert.equal(result.libraries[0].can_create,false);assert.equal(result.folders.book[0].name,"PRIVATE FOLDER");
  assert.equal(result.documents[0].can_edit,false);assert.equal(result.documents[1].can_edit,true);assert.equal(result.documents[1].can_manage,false);
  assert.equal(result.catalogs.book.revision,"101");
});

test("revoked document rows disappear completely and archived notes remain read-only outside the active catalog",()=>{
  const revoked=view([library],[{...note,role:null}]);assert.deepEqual(revoked.libraries,[]);assert.deepEqual(revoked.documents,[]);
  const archived=view([library],[{...note,archived:true}]);assert.equal(archived.documents[0].can_edit,false);assert.deepEqual(archived.catalogs.book.items,[]);
});

test("incremental fingerprints change for visible note and asset metadata but ignore hidden library structure",()=>{
  const initial=view();const fingerprint=initial.documents[0].offline_revision;assert.match(fingerprint,/^[a-f0-9]{64}$/);
  for(const patch of [{revision:"4"},{access_revision:"5"},{title:"Renamed"},{tags:["updated"]},{role:"viewer"},{asset_versions:[["asset","hash",1,"3","now","ready",{thumbnail:{hash:"new-thumb"}}]]}])
    assert.notEqual(view([library],[{...note,...patch}]).documents[0].offline_revision,fingerprint);
  const hiddenChanged=view([{...library,name:"OTHER SECRET",catalog_order:["note:another-hidden","note:shared"],catalog_revision:"9999"}]);
  assert.equal(hiddenChanged.documents[0].offline_revision,fingerprint);assert.equal(hiddenChanged.catalogs.book.revision,initial.catalogs.book.revision);
});

test("team pins and announcement IDs are filtered through the readable document set",()=>{
  const result=inventoryView([{...library,kind:"team",role:"contributor",team_id:"team"}],[{...note,role:"reviewer"}],[],[{id:"team",name:"Members only",role:"member",announcement_doc_id:"private",pinned_note_ids:["private","shared"]}],{},8);
  assert.equal(result.libraries[0].can_create,true);assert.equal(result.documents[0].can_edit,false);assert.equal(result.teams[0].announcement_doc_id,null);assert.deepEqual(result.teams[0].pinned_note_ids,["shared"]);
});
