// Run inside the API image on the isolated test network. Creates and drops its
// own PostgreSQL database; never reads production documents or credentials.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc,initProseMirrorDoc} from '@tiptap/y-tiptap';
import {canonical,schema} from '@anote/document-model';
const database='onboarding_test_'+randomUUID().replaceAll('-','');
const maintenance=new pg.Pool({host:'db',user:'anote',database:'postgres',password:process.env.DB_PASSWORD});
assert.equal(process.env.ONBOARDING_ISOLATED_TEST,'1');
await maintenance.query(`CREATE DATABASE ${database}`);
process.env.DATABASE_URL=`postgres://anote:${encodeURIComponent(process.env.DB_PASSWORD)}@db:5432/${database}`;
process.env.PUBLIC_ORIGIN='http://anote.internal:3000';
process.env.CASDOOR_CLIENT_SECRET='';process.env.CASDOOR_CLIENT_ID='';
const root='/tmp/'+database;process.env.ASSET_ROOT=root;
let db;const passed=[];
try {
  const databaseModule=await import('../../apps/api/dist/database.js');db=databaseModule.db;await databaseModule.migrate();
  const {initializePlatform}=await import('../../apps/api/dist/platform.js');await initializePlatform();
  const {initializeOnboarding,ensureOnboarding}=await import('../../apps/api/dist/onboarding.js');
  const {MCP_GUIDE_KEY,MCP_GUIDE_TITLE,TUTORIAL_TAG}=await import('../../apps/api/dist/onboarding-mcp-guide.js');
  const {purgeTrash,collectStorage}=await import('../../apps/api/dist/trash-maintenance.js');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(root+'/originals',{recursive:true});await fs.mkdir(root+'/derived',{recursive:true});
  async function person(admin=false) {const id=randomUUID();await db.query("INSERT INTO users(id,username,name,password_hash,is_admin) VALUES($1,$1,'示例用户','not-used',$2)",[id,admin]);return id;}
  async function entry(id){return (await db.query('SELECT * FROM user_onboarding WHERE user_id=$1',[id])).rows[0];}
  async function mcpEntry(id){return (await db.query('SELECT * FROM user_onboarding_guides WHERE user_id=$1 AND guide_key=$2',[id,MCP_GUIDE_KEY])).rows[0];}
  async function note(id){return (await db.query('SELECT * FROM documents WHERE id=$1',[id])).rows[0];}
  async function save(id,value){const doc=prosemirrorJSONToYDoc(schema,canonical(value),'default');try{await db.query('UPDATE documents SET snapshot=$2,ystate=$3,revision=revision+1 WHERE id=$1',[id,canonical(value),Buffer.from(Y.encodeStateAsUpdate(doc))]);}finally{doc.destroy();}}
  const author=await person(true),otherAdmin=await person(true),fresh=await person(),edited=await person(),deleted=await person(),legacy=await person();
  const init=await initializeOnboarding();assert.equal(init.pending_template,6);assert.equal(init.failed,undefined);
  const first=(await db.query('SELECT count(*) FROM spaces')).rows[0].count;await initializeOnboarding();assert.equal((await db.query('SELECT count(*) FROM spaces')).rows[0].count,first);passed.push('existing users receive exactly one default personal library without a template');
  async function makeSource(owner,title='ANote 功能与使用示例'){
    const id=randomUUID(),space=(await entry(owner)).space_id,value=canonical({type:'doc',content:[{type:'heading',attrs:{blockId:randomUUID(),level:2},content:[{type:'text',text:'使用示例'}]}]});
    const doc=prosemirrorJSONToYDoc(schema,value,'default');try{await db.query("INSERT INTO documents(id,space_id,title,created_by,snapshot,ystate,visibility) VALUES($1,$2,$3,$4,$5,$6,'private')",[id,space,title,owner,value,Buffer.from(Y.encodeStateAsUpdate(doc))]);}finally{doc.destroy();}return id;
  }
  const impostor=await makeSource(fresh);assert.equal(await ensureOnboarding(legacy),'pending_template');
  const source=await makeSource(author),ambiguous=await makeSource(otherAdmin);assert.equal(await ensureOnboarding(legacy),'pending_template');
  await db.query("UPDATE documents SET title='其他笔记' WHERE id=$1",[ambiguous]);
  const assets=[];
  for(let i=0;i<4;i++){
    const id=randomUUID(),bytes=Buffer.from('synthetic-image-'+i),key='source-'+i+'.png',hash=digest(bytes);await fs.writeFile(root+'/originals/'+key,bytes);await fs.writeFile(root+'/derived/'+id+'.jpg',bytes);
    await db.query("INSERT INTO assets(id,space_id,created_by,filename,title,mime,bytes,hash,storage_key,kind,status,owner_doc_id,metadata) VALUES($1,$2,$3,'sample.png','image','image/png',$4,$5,$6,'image','ready',$7,$8)",[id,(await entry(author)).space_id,author,bytes.length,hash,key,source,{thumbnail:{key:id+'.jpg'}}]);
    await db.query('INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2)',[source,id]);assets.push({assetId:id,src:'/api/assets/'+id+'/file',localPath:'assets/'+id+'.png',hash,label:'image'});
  }
  let value=canonical({type:'doc',content:[
    {type:'heading',attrs:{blockId:randomUUID(),level:2},content:[{type:'text',text:'使用示例'}]},
    {type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'返回当前笔记',marks:[{type:'link',attrs:{href:'/?doc='+source}}]}]},
    {type:'mediaResource',attrs:{blockId:randomUUID(),...assets[0],kind:'image',mime:'image/png',widthPercent:75,alignment:'right'}},
    {type:'imageComparison',attrs:{blockId:randomUUID(),images:assets.slice(1,3),mode:'slider',slider:38}},
    {type:'mathBlock',attrs:{blockId:randomUUID(),latex:'X_t = \\alpha X_0'}},
    {type:'codeBlock',attrs:{blockId:randomUUID(),language:'mermaid'},content:[{type:'text',text:'flowchart LR\n A-->B'}]},
    {type:'mindMap',attrs:{blockId:randomUUID()},content:[{type:'mindMapItem',attrs:{id:'root',parentId:null,x:80,y:100},content:[{type:'text',text:'中心主题'}]}]},
    {type:'taskList',attrs:{blockId:randomUUID()},content:[{type:'taskItem',attrs:{checked:false},content:[{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'试一试'}]}]}]},
  ]});
  await save(source,value);await db.query("INSERT INTO comments(id,doc_id,author,body) VALUES($1,$2,$3,'private source comment')",[randomUUID(),source,author]);
  await db.query("INSERT INTO document_share_links(id,doc_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,NULL)",[randomUUID(),source,digest('source-link'),author]);
  const initial=await note(source);assert.equal(await ensureOnboarding(fresh),'created');const target=await entry(fresh),copy=await note(target.doc_id);
  assert.equal(copy.created_by,fresh);assert.equal(copy.visibility,'private');assert.notEqual(copy.id,source);assert.equal(copy.snapshot.content[2].attrs.widthPercent,75);assert.equal(copy.snapshot.content[2].attrs.alignment,'right');
  assert.equal(copy.snapshot.content[1].content[0].marks[0].attrs.href,'/?doc='+copy.id);
  const tree=new Y.Doc();try{Y.applyUpdate(tree,copy.ystate);assert.deepEqual(canonical(initProseMirrorDoc(tree.getXmlFragment('default'),schema).doc.toJSON()),canonical(copy.snapshot));}finally{tree.destroy();}
  for(const type of ['imageComparison','mathBlock','codeBlock','mindMap','taskList'])assert.ok(copy.snapshot.content.some(n=>n.type===type));
  assert.equal((await db.query('SELECT count(*) FROM document_assets WHERE doc_id=$1',[copy.id])).rows[0].count,'3');
  for(const table of ['comments','document_collaborators','document_share_links'])assert.equal((await db.query(`SELECT count(*) FROM ${table} WHERE doc_id=$1`,[copy.id])).rows[0].count,'0');
  assert.equal((await db.query('SELECT effective_document_role($1,$2) AS role',[legacy,copy.id])).rows[0].role,null);
  passed.push('only the unique administrator template is copied; rich layout, Yjs state, independent IDs and private permissions survive');
  await Promise.all(Array.from({length:8},()=>ensureOnboarding(legacy)));assert.equal((await db.query('SELECT count(*) FROM documents WHERE created_by=$1 AND title=$2',[legacy,initial.title])).rows[0].count,'1');passed.push('concurrent visits are idempotent');
  const shared=(await entry(legacy)).doc_id;await db.query("INSERT INTO document_share_links(id,doc_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,NULL)",[randomUUID(),shared,digest('guide-link'),legacy]);
  await ensureOnboarding(edited);await ensureOnboarding(deleted);const custom=await note((await entry(edited)).doc_id);const customized=structuredClone(custom.snapshot);customized.content.push({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'我的修改'}]});await save(custom.id,customized);
  const removed=await entry(deleted);await db.query('UPDATE documents SET deleted_at=now(),trash_batch=$2 WHERE id=$1',[removed.doc_id,randomUUID()]);
  value.content.push({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'新版示例'}]});await save(source,value);
  assert.equal(await ensureOnboarding(fresh),'existing');assert.equal((await note(copy.id)).revision,copy.revision);
  assert.equal(await ensureOnboarding(fresh,true),'updated');assert.equal((await note(copy.id)).revision,String(Number(copy.revision)+1));assert.equal((await note(copy.id)).snapshot.content.at(-1).content[0].text,'新版示例');
  assert.equal((await db.query('SELECT count(*) FROM document_versions WHERE doc_id=$1',[copy.id])).rows[0].count,'2');
  assert.equal(await ensureOnboarding(edited,true),'customized');assert.deepEqual((await note(custom.id)).snapshot,canonical(customized));
  assert.equal(await ensureOnboarding(legacy,true),'customized');
  assert.equal(await ensureOnboarding(deleted,true),'dismissed');assert.ok((await note(removed.doc_id)).deleted_at);passed.push('startup refresh preserves customized and deleted guides; ordinary visits never replace live content');
  const ownerEntry=await entry(otherAdmin);await db.query('UPDATE spaces SET deleted_at=now(),trash_batch=$2 WHERE id=$1',[ownerEntry.space_id,randomUUID()]);assert.equal(await ensureOnboarding(otherAdmin),'dismissed');assert.equal((await entry(otherAdmin)).space_id,ownerEntry.space_id);passed.push('deleted default libraries are not recreated');
  const incomplete=await person();await db.query("UPDATE assets SET status='pending' WHERE id=$1",[assets[0].assetId]);await assert.rejects(()=>ensureOnboarding(incomplete));const pending=await entry(incomplete);assert.ok(pending.space_id);assert.equal(pending.guide_created,false);assert.equal((await db.query('SELECT count(*) FROM documents WHERE created_by=$1',[incomplete])).rows[0].count,'0');await db.query("UPDATE assets SET status='ready' WHERE id=$1",[assets[0].assetId]);assert.equal(await ensureOnboarding(incomplete),'created');passed.push('attachment failures roll back partial guides and can be retried without losing the library');
  const targetLibrary=randomUUID();await db.query("INSERT INTO spaces(id,name,created_by,kind,access_mode) VALUES($1,'教程源稿测试库',$2,'personal','restricted')",[targetLibrary,author]);await db.query("INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'admin')",[targetLibrary,author]);
  const mcpSource=await makeSource(author,MCP_GUIDE_TITLE),sourceAsset=randomUUID(),sourceBytes=Buffer.from('verified-guide-image');await fs.writeFile(root+'/originals/mcp-guide.png',sourceBytes);
  await db.query("INSERT INTO assets(id,space_id,created_by,filename,mime,bytes,hash,storage_key,kind,status,owner_doc_id) VALUES($1,$2,$3,'guide.png','image/png',$4,$5,'mcp-guide.png','image','ready',$6)",[sourceAsset,(await entry(author)).space_id,author,sourceBytes.length,digest(sourceBytes),mcpSource]);await db.query('INSERT INTO document_assets(doc_id,asset_id) VALUES($1,$2)',[mcpSource,sourceAsset]);
  const verified=canonical({type:'doc',content:[{type:'heading',attrs:{blockId:randomUUID(),level:2},content:[{type:'text',text:'管理员已经实测的连接步骤'}]},{type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'必须保留这份原文，不可改写为模型生成的教程。'}]},{type:'mediaResource',attrs:{blockId:randomUUID(),assetId:sourceAsset,src:'/api/assets/'+sourceAsset+'/file',localPath:'assets/'+sourceAsset+'.png',kind:'image',mime:'image/png',widthPercent:75,alignment:'right'}}]});await save(mcpSource,verified);
  await db.query("UPDATE documents SET space_id=$2,tags=array_append(tags,$3) WHERE id=$1",[mcpSource,targetLibrary,TUTORIAL_TAG]);
  await db.query("UPDATE assets SET space_id=$2 WHERE owner_doc_id=$1",[mcpSource,targetLibrary]);
  await db.query("UPDATE documents SET tags=array_append(tags,$2) WHERE id=$1 AND NOT $2=ANY(tags)",[source,TUTORIAL_TAG]);
  await initializeOnboarding();const freshMcp=await note((await mcpEntry(fresh)).doc_id);assert.equal(freshMcp.title,MCP_GUIDE_TITLE);assert.equal(freshMcp.visibility,'private');assert.equal(freshMcp.created_by,fresh);assert.equal(freshMcp.space_id,(await entry(fresh)).space_id);assert.ok(freshMcp.tags.includes(TUTORIAL_TAG));assert.equal(freshMcp.snapshot.content[1].content[0].text,verified.content[1].content[0].text);assert.equal(freshMcp.snapshot.content[2].attrs.widthPercent,75);assert.equal(freshMcp.snapshot.content[2].attrs.alignment,'right');assert.notEqual(freshMcp.snapshot.content[2].attrs.assetId,sourceAsset);
  for(const userId of [fresh,legacy,author]){assert.ok((await note((await entry(userId)).doc_id)).tags.includes(TUTORIAL_TAG));assert.ok((await note((await mcpEntry(userId)).doc_id)).tags.includes(TUTORIAL_TAG));}
  assert.equal((await db.query('SELECT effective_document_role($1,$2) AS role',[legacy,freshMcp.id])).rows[0].role,null);assert.equal((await db.query('SELECT source_doc_id FROM onboarding_guide_templates WHERE guide_key=$1',[MCP_GUIDE_KEY])).rows[0].source_doc_id,mcpSource);passed.push('MCP guides are exact private copies of the administrator tested version, preserve media layout and include the tutorial tag');
  const newcomer=await person();await Promise.all(Array.from({length:8},()=>ensureOnboarding(newcomer)));assert.equal((await db.query('SELECT count(*) FROM documents WHERE created_by=$1 AND title=$2',[newcomer,MCP_GUIDE_TITLE])).rows[0].count,'1');const newGuide=await note((await mcpEntry(newcomer)).doc_id);assert.equal(newGuide.space_id,(await entry(newcomer)).space_id);passed.push('new and concurrent users receive one guide in their own default library');
  const customMcp=await note((await mcpEntry(edited)).doc_id),customMcpBody=structuredClone(customMcp.snapshot);customMcpBody.content.push({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'个人补充'}]});await save(customMcp.id,customMcpBody);const deletedMcp=await mcpEntry(deleted);await db.query('UPDATE documents SET deleted_at=now(),trash_batch=$2 WHERE id=$1',[deletedMcp.doc_id,randomUUID()]);verified.content.push({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text:'管理员后续补充'}]});await save(mcpSource,verified);
  const priorMcp=await note(freshMcp.id),priorRevision=priorMcp.revision;await ensureOnboarding(fresh);assert.equal((await note(freshMcp.id)).revision,priorRevision);await ensureOnboarding(fresh,true);const updatedMcp=await note(freshMcp.id);assert.equal(updatedMcp.snapshot.content.at(-1).content[0].text,'管理员后续补充');const reconnected=new Y.Doc();try{Y.applyUpdate(reconnected,updatedMcp.ystate);Y.applyUpdate(reconnected,priorMcp.ystate);assert.deepEqual(canonical(initProseMirrorDoc(reconnected.getXmlFragment('default'),schema).doc.toJSON()),canonical(updatedMcp.snapshot));}finally{reconnected.destroy();}await ensureOnboarding(edited,true);assert.deepEqual((await note(customMcp.id)).snapshot,canonical(customMcpBody));await ensureOnboarding(deleted,true);assert.ok((await note(deletedMcp.doc_id)).deleted_at);passed.push('administrator updates preserve collaborative deletion history so stale reconnects cannot restore old guide text; user edits and deleted guides remain preserved');
  await db.query("UPDATE documents SET deleted_at=now()-interval '31 days' WHERE id=$1",[deletedMcp.doc_id]);await purgeTrash('documents',deletedMcp.doc_id,{automatic:true});await ensureOnboarding(deleted,true);assert.equal((await mcpEntry(deleted)).doc_id,null);assert.equal((await mcpEntry(deleted)).guide_created,true);passed.push('permanently deleted MCP guides never reappear');
  await db.query("UPDATE documents SET deleted_at=now()-interval '31 days',trash_batch=$2 WHERE id=$1",[source,randomUUID()]);await purgeTrash('documents',source,{automatic:true});await collectStorage();
  assert.ok(await fs.stat(root+'/originals/source-0.png'));assert.ok(await fs.stat(root+'/derived/'+assets[0].assetId+'.jpg'));assert.equal((await db.query('SELECT source_doc_id FROM onboarding_template')).rows[0].source_doc_id,null);
  assert.equal(await ensureOnboarding(await person()),'pending_template');passed.push('purging the original preserves copied files and thumbnails; copies never become replacement templates');
  const proof={verifiedAt:new Date().toISOString(),isolatedDatabase:true,cases:passed.length,passed,productionDataAccessed:false};
  await fs.mkdir('artifacts/server',{recursive:true});await fs.writeFile('artifacts/server/onboarding-evidence.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
} finally {
  await db?.end();await fs.rm(root,{recursive:true,force:true});await maintenance.query(`DROP DATABASE ${database} WITH (FORCE)`);await maintenance.end();
}
