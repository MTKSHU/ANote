import {canonical,schema,type RichDoc} from '@anote/document-model';
import {stable} from '@anote/sync-core';
import {digest} from './database.js';

const own=(value:object,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const object=(value:any):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// Old snapshots may predate attributes added to the editor schema. Accept
// precisely those absent attributes and their declared defaults. Never hide a
// removed field, a changed existing value, text, marks, or document structure.
function onlyDefaultAttributesAdded(source:any,normalized:any):boolean{
  if(stable(source)===stable(normalized))return true;
  if(Array.isArray(source)&&Array.isArray(normalized))return source.length===normalized.length&&source.every((value,index)=>onlyDefaultAttributesAdded(value,normalized[index]));
  if(!object(source)||!object(normalized))return false;
  const type=typeof source.type==='string'&&source.type===normalized.type?(schema.nodes[source.type]||schema.marks[source.type]):undefined;
  for(const key of new Set([...Object.keys(source),...Object.keys(normalized)])){
    if(key==='attrs'&&type&&object(normalized.attrs)&&(!own(source,'attrs')||object(source.attrs))){
      const before=source.attrs||{},after=normalized.attrs;
      for(const attribute of new Set([...Object.keys(before),...Object.keys(after)])){
        if(own(before,attribute)){if(!own(after,attribute)||stable(before[attribute])!==stable(after[attribute]))return false;}
        else{
          const specification=type.spec.attrs?.[attribute];
          if(!specification||!own(specification,'default')||stable(after[attribute])!==stable(specification.default))return false;
        }
      }
    }else if(!own(source,key)||!own(normalized,key)||!onlyDefaultAttributesAdded(source[key],normalized[key]))return false;
  }
  return true;
}

export function validateSnapshotRepresentation(snapshot:RichDoc){
  const normalized=canonical(snapshot);
  if(!onlyDefaultAttributesAdded(snapshot,normalized))throw new Error('Snapshot normalization changes more than declared missing attribute defaults');
  return {rawHash:digest(stable(snapshot)),semanticHash:digest(stable(normalized))};
}
