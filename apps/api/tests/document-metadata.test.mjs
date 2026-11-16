import test from 'node:test';
import assert from 'node:assert/strict';
import {Documents} from '../dist/documents.js';
import {db} from '../dist/database.js';

test('editor metadata never opens or decodes the collaboration document, including a cache miss',async t=>{
  const query=db.query,queries=[],note={id:'metadata-note',space_id:'book',archived:false,deleted_at:null,role:'editor'};
  const info={id:note.id,space_id:'book',title:'Existing title',revision:8,tags:['tag'],archived:false,space_name:'Book',space_kind:'personal',last_editors:[{name:'Editor'}],collaborator_count:1,external_link_count:2};
  db.query=async(sql,values)=>{queries.push({sql,values});return {rows:[queries.length===1?note:info]};};
  t.after(()=>{db.query=query;});
  const documents=new Documents();documents.access=()=>{throw new Error('Metadata must not hydrate a Y.Doc');};
  const result=await documents.getMetadata({id:'reader'},note.id);
  assert.equal(result.role,'editor');assert.equal(result.can_manage,false);assert.equal(result.title,info.title);
  assert.deepEqual(result.last_editors,info.last_editors);
  for(const key of ['snapshot','ystate','hash'])assert.equal(Object.hasOwn(result,key),false);
  assert.equal(queries.length,2);
  assert(queries.every(({sql})=>!/(?:\bystate\b|\bsnapshot\b|SELECT\s+\*)/i.test(sql)));
});

test('metadata preserves missing, revoked and trashed note access rules before reading page information',async t=>{
  const query=db.query;t.after(()=>{db.query=query;});
  const documents=new Documents();documents.access=()=>{throw new Error('Must not load document');};
  for(const [row,status] of [[undefined,404],[{id:'note',role:null},403],[{id:'note',role:'admin',deleted_at:new Date()},404]]){
    let queries=0;db.query=async()=>{queries++;return {rows:row?[row]:[]};};
    await assert.rejects(documents.getMetadata({id:'reader'},'note'),error=>error.getStatus()===status);
    assert.equal(queries,1);
  }
});
