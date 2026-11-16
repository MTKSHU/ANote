import assert from "node:assert/strict";
import {test} from "node:test";
import {sidebarLibraries,sidebarLibraryNotes} from "../../apps/desktop/renderer/sidebar-libraries";

const stamp=(index:number)=>new Date(Date.UTC(2020,0,1+index)).toISOString();
const book=(id:string,pin?:number)=>({id,sidebar_pinned:pin!==undefined,sidebar_pinned_at:pin===undefined?null:stamp(pin)});
const note=(id:string,space_id:string,index:number,archived=false)=>({id,space_id,updated_at:stamp(index),archived,title:id});
const ids=(values:{id:string}[])=>values.map(value=>value.id);

test("three libraries: first-pinned order precedes most recent readable note activity",()=>{
  const books=[book("new-pin",10),book("recent"),book("old-pin",2),book("older"),book("empty")];
  const notes=[note("older-note","older",5),note("recent-note","recent",6)];
  assert.deepEqual(ids(sidebarLibraries(books,notes,notes)),["old-pin","new-pin","recent"]);
  assert.deepEqual(ids(sidebarLibraries(books.filter(value=>!value.sidebar_pinned),notes,notes)),["recent","older"]);
});

test("more than three pins are retained in source while only the earliest three appear",()=>{
  const books=[book("fourth",4),book("second",2),book("newest"),book("first",1),book("third",3)];
  const notes=[note("active","newest",30000)],before=structuredClone(books);
  assert.deepEqual(ids(sidebarLibraries(books,notes,notes)),["first","second","third"]);
  assert.deepEqual(books,before);
  const unpinned=books.map(value=>value.id==="first"?{...value,sidebar_pinned:false,sidebar_pinned_at:null}:value);
  assert.deepEqual(ids(sidebarLibraries(unpinned,notes,notes)),["second","third","fourth"]);
});

test("inaccessible, archived, moved and other-space notes cannot promote a library",()=>{
  const books=[book("a"),book("b"),book("c"),book("d"),book("e")];
  const activity=[note("secret","a",30000),note("archive","b",30000),note("moved","c",30000),note("already-archived","e",30000,true),note("readable","d",1),note("outside","outside-scope",40000)];
  const current=[{...activity[1],archived:true},{...activity[2],space_id:"outside-scope"},{...activity[3],archived:false},activity[4],activity[5]];
  assert.deepEqual(ids(sidebarLibraries(books,current,activity)),["d"]);
  assert.deepEqual(ids(sidebarLibraryNotes("a",current,activity)),[]);
  assert.deepEqual(ids(sidebarLibraryNotes("b",current,activity)),[]);
  assert.deepEqual(ids(sidebarLibraryNotes("c",current,activity)),[]);
  assert.deepEqual(ids(sidebarLibraryNotes("e",current,activity)),[]);
});

test("snapshot freezes editing order while current readable metadata remains fresh",()=>{
  const books=[book("a"),book("b"),book("c"),book("d")],activity=books.map((value,index)=>note(value.id+"-note",value.id,index));
  const current=activity.map(value=>value.space_id==="a"?{...value,updated_at:stamp(30000),title:"fresh title"}:value);
  assert.deepEqual(ids(sidebarLibraries(books,current,activity)),["d","c","b"]);
  assert.deepEqual(ids(sidebarLibraries(books,current,current)),["a","d","c"]);
  assert.equal(sidebarLibraryNotes("a",current,activity)[0].title,"fresh title");
});

test("each library shows only three distinct recent readable notes without mutating activity",()=>{
  const activity=[note("one","a",1),note("four","a",4),note("three","a",3),note("two","a",2),note("other","b",5)],before=structuredClone(activity);
  assert.deepEqual(ids(sidebarLibraryNotes("a",activity,[...activity,activity[1]])),["four","three","two"]);
  assert.deepEqual(activity,before);
  const current=activity.map(value=>value.id==="four"?{...value,archived:true}:value);
  assert.deepEqual(ids(sidebarLibraryNotes("a",current,activity)),["three","two","one"]);
});

test("equal or missing timestamps use deterministic ID order and epoch dates stay eligible",()=>{
  const books=[book("z"),book("a"),book("m"),book("old")],activity=[note("z-note","z",1),note("a-note","a",1),{...note("m-note","m",0),updated_at:"1970-01-01T00:00:00.000Z"},{...note("old-note","old",0),updated_at:"1969-01-01T00:00:00.000Z"}];
  assert.deepEqual(ids(sidebarLibraries(books,activity,activity)),["a","z","m"]);
  const pins=[{id:"z",sidebar_pinned:true,sidebar_pinned_at:"invalid"},{id:"a",sidebar_pinned:true,sidebar_pinned_at:null},book("valid",1)];
  assert.deepEqual(ids(sidebarLibraries(pins,[],[])),["a","z","valid"]);
  const sameTime=[note("z","a",1),note("a","a",1),note("m","a",1),note("b","a",1)];
  assert.deepEqual(ids(sidebarLibraryNotes("a",sameTime,sameTime)),["a","b","m"]);
});
