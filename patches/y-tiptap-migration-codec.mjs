/** Lossless, versioned storage for y-tiptap position migrations.
 * Binary rows are grouped by source client and indexed in small clock ranges.
 * Reading a live cursor need not materialize every historical transfer. */
export function createANoteMigrationCodec(){
  const MAGIC=[65,78,77,2],PREFIX='__tiptap_position_migrations:',META='__anote_sync_meta',BLOCK=64,MAX=Number.MAX_SAFE_INTEGER,headers=new WeakMap(),storeCaches=new WeakMap(),validated=new WeakSet(),legacyIndexes=new WeakMap();
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const fail=()=>{throw new Error('Invalid ANote position migration encoding');};
  const integer=value=>{if(!Number.isSafeInteger(value)||value<0||Object.is(value,-0))fail();return value;};
  const signed=value=>{if(!Number.isSafeInteger(value)||Object.is(value,-0))fail();return value;};
  const keys=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail();};
  const identity=value=>{keys(value,['client','clock']);integer(value.client);integer(value.clock);};
  class Writer{
    constructor(){this.bytes=[];}
    n(value){integer(value);while(value>127){this.bytes.push(value%128+128);value=Math.floor(value/128);}this.bytes.push(value);}
    s(value){signed(value);let magnitude=Math.abs(value),first=magnitude%64+(value<0?64:0);magnitude=Math.floor(magnitude/64);this.bytes.push(first+(magnitude?128:0));while(magnitude>127){this.bytes.push(magnitude%128+128);magnitude=Math.floor(magnitude/128);}if(first&128)fail();if(Math.abs(value)>=64)this.bytes.push(magnitude);}
    text(value){if(typeof value!=='string')fail();this.n(value.length);for(let index=0;index<value.length;index++)this.n(value.charCodeAt(index));}
    raw(bytes){for(const value of bytes)this.bytes.push(value);}
    result(){if(this.bytes.length>64*1024*1024)fail();return Uint8Array.from(this.bytes);}
  }
  class Reader{
    constructor(bytes,start=0,end=bytes.byteLength){this.bytes=bytes;this.offset=start;this.end=end;}
    byte(){if(this.offset>=this.end)fail();return this.bytes[this.offset++];}
    n(){let value=0,factor=1,byte;do{byte=this.byte();value+=(byte%128)*factor;if(!Number.isSafeInteger(value))fail();factor*=128;if(factor>MAX*128)fail();}while(byte&128);return value;}
    s(){const first=this.byte();let value=first%64,factor=64,byte=first;while(byte&128){byte=this.byte();value+=(byte%128)*factor;if(!Number.isSafeInteger(value))fail();factor*=128;if(factor>MAX*128)fail();}if((first&64)&&value===0)fail();return first&64?-value:value;}
    text(){const length=this.n();if(length>this.end-this.offset)fail();let text='',part=[];for(let index=0;index<length;index++){const code=this.n();if(code>65535)fail();part.push(code);if(part.length===256){text+=String.fromCharCode(...part);part=[];}}return text+String.fromCharCode(...part);}
    count(){const value=this.n();if(value>this.bytes.byteLength)fail();return value;}
  }
  const boundary=(value,key)=>!own(value,key)?0:value[key]===undefined?3:value[key]===null?4:value[key]==='start'?1:value[key]==='end'?2:fail();
  const optional=(value,key,type)=>!own(value,key)?0:value[key]===undefined?2:value[key]===null?3:typeof value[key]===type?1:fail();
  const setBoundary=(value,key,mode)=>{if(mode===1)value[key]='start';else if(mode===2)value[key]='end';else if(mode===3)value[key]=undefined;else if(mode===4)value[key]=null;else if(mode!==0)fail();};
  const isEncoded=value=>value instanceof Uint8Array&&MAGIC.every((byte,index)=>value[index]===byte);
  const isBinary=value=>value instanceof Uint8Array;
  function validate(record){
    if(validated.has(record))return record;
    keys(record,['version','client','clock','seen','transfers']);if(record.version!==1||!Array.isArray(record.seen)||!Array.isArray(record.transfers))fail();integer(record.client);integer(record.clock);
    for(const pair of record.seen){if(!Array.isArray(pair)||pair.length!==2)fail();integer(pair[0]);integer(pair[1]);}
    for(const transfer of record.transfers){keys(transfer,['source','target']);keys(transfer.source,['client','clock','length','boundary']);integer(transfer.source.client);integer(transfer.source.clock);if(integer(transfer.source.length)===0||!Number.isSafeInteger(transfer.source.clock+transfer.source.length))fail();boundary(transfer.source,'boundary');
      if(transfer.target!==null){const target=transfer.target;keys(target,['client','clock','type','tname','assoc','boundary']);integer(target.client);integer(target.clock);if(own(target,'type')&&target.type!==null&&target.type!==undefined)identity(target.type);boundary(target,'boundary');if(optional(target,'assoc','number')===1)signed(target.assoc);optional(target,'tname','string');}
    }validated.add(record);return record;
  }
  function encode(record){
    if(isEncoded(record)){header(record);return record;}validate(record);
    const clients=[],dictionary=new Map(),index=value=>{if(!dictionary.has(value)){dictionary.set(value,clients.length);clients.push(value);}return dictionary.get(value);};index(record.client);for(const [client]of record.seen)index(client);
    const groups=new Map();record.transfers.forEach((transfer,ordinal)=>{index(transfer.source.client);if(transfer.target){index(transfer.target.client);if(transfer.target.type)index(transfer.target.type.client);}const rows=groups.get(transfer.source.client)||[];rows.push({transfer,ordinal});groups.set(transfer.source.client,rows);});
    const output=new Writer();output.raw(MAGIC);output.n(clients.length);for(const client of clients)output.n(client);output.n(index(record.client));output.n(record.clock);output.n(record.seen.length);for(const [client,clock]of record.seen){output.n(index(client));output.n(clock);}output.n(record.transfers.length);output.n(groups.size);
    for(const [client,rows]of groups){rows.sort((left,right)=>left.transfer.source.clock-right.transfer.source.clock||left.ordinal-right.ordinal);output.n(index(client));output.n(rows.length);output.n(Math.ceil(rows.length/BLOCK));
      for(let start=0;start<rows.length;start+=BLOCK){const block=rows.slice(start,start+BLOCK),minimum=block[0].transfer.source.clock,maximum=Math.max(...block.map(row=>row.transfer.source.clock+row.transfer.source.length)),payload=new Writer();let previousSource=minimum,previousTarget=0,previousType=0,previousOrdinal=-1;
        for(const {transfer,ordinal}of block){const source=transfer.source,target=transfer.target;let flags=boundary(source,'boundary');if(target){const typeMode=!own(target,'type')?3:target.type===undefined?2:target.type===null?0:1;flags|=8|(boundary(target,'boundary')<<4)|(optional(target,'assoc','number')<<7)|(optional(target,'tname','string')<<9)|(typeMode<<11);}
          payload.s(ordinal-previousOrdinal);previousOrdinal=ordinal;payload.n(flags);payload.n(source.clock-previousSource);previousSource=source.clock;payload.n(source.length);
          if(target){payload.n(index(target.client));payload.s(target.clock-previousTarget);previousTarget=target.clock;if(((flags>>11)&3)===1){payload.n(index(target.type.client));payload.s(target.type.clock-previousType);previousType=target.type.clock;}if(((flags>>7)&3)===1)payload.s(target.assoc);if(((flags>>9)&3)===1)payload.text(target.tname);}
        }
        const bytes=payload.result();output.n(minimum);output.n(maximum-minimum);output.n(block.length);output.n(bytes.length);output.raw(bytes);
      }
    }
    return output.result();
  }
  function header(bytes){
    let parsed=headers.get(bytes);if(parsed)return parsed;if(!isEncoded(bytes))fail();const reader=new Reader(bytes,4),clients=[];for(let count=reader.count();count>0;count--)clients.push(reader.n());if(!clients.length||new Set(clients).size!==clients.length)fail();
    const clientAt=index=>{if(index>=clients.length)fail();return clients[index];};
    const client=clientAt(reader.n()),clock=reader.n(),seen=[];for(let count=reader.count();count>0;count--)seen.push([clientAt(reader.n()),reader.n()]);
    const transferCount=reader.count(),groups=new Map();let total=0;
    for(let count=reader.count();count>0;count--){const sourceClient=clientAt(reader.n()),rows=reader.count(),blockCount=reader.count(),blocks=[];if(groups.has(sourceClient)||!rows||blockCount!==Math.ceil(rows/BLOCK))fail();let rowTotal=0,previous=-1,prefixEnd=0;
      for(let block=0;block<blockCount;block++){const minimum=reader.n(),span=reader.n(),size=reader.count(),length=reader.n();if(minimum<previous||span===0||!Number.isSafeInteger(minimum+span)||!size||size>BLOCK||length>reader.end-reader.offset)fail();previous=minimum;rowTotal+=size;prefixEnd=Math.max(prefixEnd,minimum+span);blocks.push({minimum,end:minimum+span,prefixEnd,size,start:reader.offset,endOffset:reader.offset+length});reader.offset+=length;}
      if(rowTotal!==rows)fail();total+=rows;groups.set(sourceClient,blocks);
    }
    if(total!==transferCount||reader.offset!==reader.end)fail();
    const record={version:1,client,clock,seen};parsed={record,clients,groups,transferCount,bytes,all:null};Object.defineProperty(record,'transfers',{enumerable:true,get(){if(!parsed.all){const all=new Array(transferCount);for(const [sourceClient,blocks]of groups)for(const block of blocks)readBlock(parsed,sourceClient,block,(transfer,ordinal)=>{if(ordinal>=transferCount||all[ordinal])fail();all[ordinal]=transfer;});if(all.some(value=>value===undefined)||Object.keys(all).length!==transferCount)fail();parsed.all=all;}return parsed.all;}});headers.set(bytes,parsed);return parsed;
  }
  function readBlock(parsed,sourceClient,block,visit,query,onOrdinal){
    const reader=new Reader(parsed.bytes,block.start,block.endOffset);let sourceClock=block.minimum,targetClock=0,typeClock=0,ordinal=-1;
    const clientAt=index=>{if(index>=parsed.clients.length)fail();return parsed.clients[index];};
    for(let row=0;row<block.size;row++){ordinal+=reader.s();const flags=reader.n();if(flags>=8192||((flags>>4)&7)>4||ordinal<0||ordinal>=parsed.transferCount)fail();if(onOrdinal)onOrdinal(ordinal);sourceClock+=reader.n();const length=reader.n(),sourceMode=flags&7;if(!length||sourceClock<block.minimum||sourceClock+length>block.end||!Number.isSafeInteger(sourceClock+length)||sourceMode>4)fail();
      const boundaryMatches=query?.boundary===undefined?(sourceMode===0||sourceMode===3):sourceMode===(query.boundary==='start'?1:2),selected=!query||sourceClock<=query.clock&&query.clock<sourceClock+length&&boundaryMatches;let target=null;
      if(flags&8){const targetClient=clientAt(reader.n());targetClock+=reader.s();if(!Number.isSafeInteger(targetClock)||targetClock<0)fail();const targetMode=(flags>>11)&3;let type;
        if(targetMode===1){const typeClient=clientAt(reader.n());typeClock+=reader.s();if(!Number.isSafeInteger(typeClock)||typeClock<0)fail();if(selected)type={client:typeClient,clock:typeClock};}
        const assocMode=(flags>>7)&3,assoc=assocMode===1?reader.s():undefined,tnameMode=(flags>>9)&3,tname=tnameMode===1?reader.text():undefined;
        if(selected){target={client:targetClient,clock:targetClock};if(targetMode===0)target.type=null;else if(targetMode===1)target.type=type;else if(targetMode===2)target.type=undefined;setBoundary(target,'boundary',(flags>>4)&7);if(assocMode)target.assoc=assocMode===3?null:assoc;if(tnameMode)target.tname=tnameMode===3?null:tname;}
      }else if(flags&~7)fail();
      if(selected){const source={client:sourceClient,clock:sourceClock,length};setBoundary(source,'boundary',sourceMode);visit({source,target},ordinal);}
    }
    if(reader.offset!==reader.end)fail();
  }
  const decode=value=>isBinary(value)?header(value).record:validate(value);
  function validateValue(value){
    if(!isBinary(value)){validate(value);return;}
    const parsed=header(value);if(parsed.validated)return;const ordinals=new Uint8Array(parsed.transferCount);let count=0;
    for(const [sourceClient,blocks]of parsed.groups)for(const block of blocks)readBlock(parsed,sourceClient,block,()=>{}, {clock:-1,boundary:undefined},ordinal=>{if(ordinals[ordinal])fail();ordinals[ordinal]=1;count++;});
    if(count!==parsed.transferCount)fail();parsed.validated=true;
  }
  function recordCandidates(value,position){
    const identity=position.item??position.type,boundary=position.item?undefined:position.assoc<0?'start':'end';if(!identity)return [];
    if(!isBinary(value)){const record=validate(value);let groups=legacyIndexes.get(record);if(!groups){groups=new Map();for(const transfer of record.transfers){const rows=groups.get(transfer.source.client)||[];rows.push(transfer);groups.set(transfer.source.client,rows);}legacyIndexes.set(record,groups);}return (groups.get(identity.client)||[]).filter(transfer=>transfer.source.boundary===boundary&&transfer.source.clock<=identity.clock&&identity.clock<transfer.source.clock+transfer.source.length).map(transfer=>({migration:record,transfer}));}
    const parsed=header(value),blocks=parsed.groups.get(identity.client);if(!blocks)return [];let lower=0,upper=blocks.length-1,last=-1;while(lower<=upper){const middle=(lower+upper)>>>1;if(blocks[middle].minimum<=identity.clock){last=middle;lower=middle+1;}else upper=middle-1;}
    const found=[];for(let index=last;index>=0&&blocks[index].prefixEnd>identity.clock;index--){const block=blocks[index];if(block.end>identity.clock)readBlock(parsed,identity.client,block,(transfer,ordinal)=>found.push({migration:parsed.record,transfer,ordinal}),{clock:identity.clock,boundary});}
    found.sort((left,right)=>left.ordinal-right.ordinal);return found.map(({migration,transfer})=>({migration,transfer}));
  }
  function candidates(store,position){
    const identity=position.item??position.type;if(!identity)return [];const key=identity.client+':'+identity.clock+':'+(position.item?'item':position.assoc<0?'start':'end');let state=storeCaches.get(store);
    if(!state){state={queries:new Map()};store.observe(()=>state.queries.clear());storeCaches.set(store,state);}const cacheable=!store.doc?._transaction,cached=cacheable?state.queries.get(key):undefined;if(cached)return cached;
    const all=[];store.forEach(value=>all.push(...recordCandidates(value,position)));const result=all.filter(candidate=>!all.some(other=>other.migration!==candidate.migration&&other.migration.seen.some(([client,clock])=>client===candidate.migration.client&&clock>candidate.migration.clock)));
    if(cacheable){if(state.queries.size>=128)state.queries.delete(state.queries.keys().next().value);state.queries.set(key,result);}return result;
  }
  function stores(doc){return [...doc.share.keys()].filter(name=>name.startsWith(PREFIX)).map(name=>doc.getMap(name));}
  function documentEncoding(doc){const marker=doc.share.has(META)?doc.getMap(META).get('migrationEncoding'):undefined;if(marker!==undefined&&marker!==1&&marker!==2)fail();let result=marker===2?2:1;for(const store of stores(doc))store.forEach(value=>{if(isBinary(value)){header(value);result=2;}});return result;}
  function validateDocument(doc){const encoding=documentEncoding(doc);for(const store of stores(doc))store.forEach(validateValue);return encoding;}
  function setEncoding(doc,encoding=2){const current=documentEncoding(doc);if(encoding!==2){if(current===2)throw new Error('Document migration encoding cannot be downgraded');if(encoding!==1)fail();return 1;}const meta=doc.getMap(META);if(meta.get('migrationEncoding')!==2)meta.set('migrationEncoding',2);return 2;}
  function compact(doc){
    const plans=[];let records=0,converted=0,transfers=0,beforeRecordJsonBytes=0,afterBinaryBytes=0;const utf8=new TextEncoder();
    for(const store of stores(doc))store.forEach((value,key)=>{records++;if(isBinary(value)){validateValue(value);const parsed=header(value);transfers+=parsed.transferCount;afterBinaryBytes+=value.byteLength;}else{validate(value);const bytes=encode(value);transfers+=value.transfers.length;beforeRecordJsonBytes+=utf8.encode(JSON.stringify(value)).byteLength;afterBinaryBytes+=bytes.byteLength;plans.push({store,key,bytes});converted++;}});
    documentEncoding(doc);const markerChanged=!doc.share.has(META)||doc.getMap(META).get('migrationEncoding')!==2;doc.transact(()=>{for(const plan of plans)plan.store.set(plan.key,plan.bytes);if(markerChanged)setEncoding(doc,2);},'anote:migration-encoding-v2');
    return {changed:converted>0||markerChanged,records,converted,transfers,beforeRecordJsonBytes,afterBinaryBytes,encoding:2};
  }
  return {encode,decode,candidates,isEncoded,documentEncoding,validateDocument,setEncoding,compact,inspect:value=>{if(isBinary(value)){const parsed=header(value);return {encoding:2,client:parsed.record.client,clock:parsed.record.clock,transfers:parsed.transferCount,bytes:value.byteLength};}validate(value);return {encoding:1,client:value.client,clock:value.clock,transfers:value.transfers.length};}};
}

// Public module interface; the guarded vendor patch embeds only the factory.
const codec=createANoteMigrationCodec();
export const MIGRATION_ENCODING_VERSION=2;
export const encodePositionMigration=codec.encode;
export const decodePositionMigration=codec.decode;
export const isEncodedPositionMigration=codec.isEncoded;
export const inspectPositionMigration=codec.inspect;
export const scanDocumentMigrationEncoding=codec.documentEncoding;
export const validateDocumentMigrationValues=codec.validateDocument;
export const setDocumentMigrationEncoding=codec.setEncoding;
export const compactDocumentMigrationValues=codec.compact;
