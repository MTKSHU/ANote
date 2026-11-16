import {randomUUID,createHash} from 'node:crypto';
import * as Y from 'yjs';
import {prosemirrorJSONToYDoc} from '@tiptap/y-tiptap';
import {schema} from '@anote/document-model';

/** Small visible document, large valid historical migration map. Every source
 * client is synthetic and distinct from the live document's client, so none
 * of these history records can remap a live caret, comment or text item. */
export function historyHeavyTodo052(){
  const content:any[]=[],pattern='记录待办事项与验证离线保存 abcdefghijklmnopqrstuvwxyz。';
  let task=0,paragraph=0,targetBlockId='',targetText='';
  const p=(text:string)=>({type:'paragraph',attrs:{blockId:randomUUID()},content:[{type:'text',text}]});
  for(let group=0;group<21;group++){
    const items=[];
    for(let index=0;index<(group<18?5:4);index++){
      const text=(String(task).padStart(3,'0')+' '+pattern.repeat(3)).slice(0,60),node=p(text);
      targetBlockId=node.attrs.blockId;targetText=text;
      items.push({type:'taskItem',attrs:{checked:task%3===0},content:[node]});task++;
    }
    content.push({type:'taskList',attrs:{blockId:randomUUID()},content:items});
    if(group%2===0)content.push(p(('正文 '+String(paragraph++).padStart(2,'0')+' '+pattern.repeat(2)).slice(0,38)));
  }
  const snapshot=schema.nodeFromJSON({type:'doc',content}).toJSON(),document=prosemirrorJSONToYDoc(schema,snapshot,'default');
  const fake=[2147483646,2147483645,2147483644,2147483643].filter(client=>client!==document.clientID),[writer,source,target]=fake;
  const history=document.getMap('__tiptap_position_migrations:root:default');
  const recordCount=562,transferCount=160376;
  let ordinal=100000;
  document.transact(()=>{
    for(let record=0;record<recordCount;record++){
      const count=Math.floor(transferCount/recordCount)+(record<transferCount%recordCount?1:0),transfers=[];
      for(let index=0;index<count;index++,ordinal++)transfers.push({source:{client:source,clock:ordinal*2,length:1},target:{client:target,clock:ordinal*3,type:{client:target,clock:0},assoc:0}});
      history.set(`${writer}:${record+1}`,{version:1,client:writer,clock:record+1,seen:record?[[writer,record]]:[],transfers});
    }
  });
  const update=Y.encodeStateAsUpdate(document),historyJson=JSON.stringify([...history.entries()]);
  const stats={tasks:task,taskLists:21,rootBlocks:content.length,characters:schema.nodeFromJSON(snapshot).textContent.length,migrationRecords:recordCount,migrationTransfers:transferCount,ystateBytes:update.length,historyJsonBytes:Buffer.byteLength(historyJson),historySha256:createHash('sha256').update(historyJson).digest('hex'),liveClient:document.clientID,fakeSourceClient:source};
  if(update.length<16.5*1024*1024||update.length>=18*1024*1024)throw new Error('History fixture must fit the offline API and retain approximately 17 MiB');
  return {document,update,snapshot,stats,targetBlockId,targetText};
}
