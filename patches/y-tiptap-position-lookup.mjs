/**
 * ANote's position-lookup acceleration for @tiptap/y-tiptap 3.0.10.
 *
 * Keep upstream's move identity/step mapping unchanged. Immutable ProseMirror
 * node occurrences provide the same child/ancestor candidates as nodeAt and
 * resolve, without re-scanning a large sibling fragment for every character.
 * This factory is embedded by the guarded dependency patch and imported by
 * semantic-equivalence tests; it has no dependency on application modules.
 */
export function createANoteMovedPositionFinder(findMovedNode){
  const cache=new WeakMap();
  function lookup(doc,key){
    const previous=cache.get(key);if(previous)return previous;
    const occurrences=[],parents=[];
    doc.descendants((node,start)=>{
      while(parents.length&&start>=parents[parents.length-1].end)parents.pop();
      const occurrence={node,start,end:start+node.nodeSize-1,parent:parents[parents.length-1]||null};
      occurrences.push(occurrence);
      if(!node.isText&&!node.isLeaf)parents.push(occurrence);
    });
    cache.set(key,occurrences);return occurrences;
  }
  return function findMovedPosition(position,step,docs,indexes){
    const doc=docs[step];
    if(!(position>=0&&position<=doc.content.size))throw new RangeError("Position "+position+" out of range");
    const occurrences=lookup(doc,indexes[step]);
    let lower=0,upper=occurrences.length-1,found=-1;
    while(lower<=upper){const middle=(lower+upper)>>>1;if(occurrences[middle].start<=position){found=middle;lower=middle+1;}else upper=middle-1;}
    if(found<0)return null;
    const occurrence=occurrences[found];
    if(occurrence.start===position&&!occurrence.node.isText){
      const moved=findMovedNode(occurrence.node,0,step,indexes);if(moved)return moved;
    }
    for(let ancestor=occurrence.start===position||occurrence.node.isText?occurrence.parent:occurrence;ancestor;ancestor=ancestor.parent){
      if(position>ancestor.start&&position<=ancestor.end){
        const moved=findMovedNode(ancestor.node,position-ancestor.start,step,indexes);if(moved)return moved;
      }
    }
    return null;
  };
}
