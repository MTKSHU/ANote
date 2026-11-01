export type CatalogEntry = { key: string; kind: "folder" | "note"; id: string; parent_id: string | null };
/** Moves one entry; siblings keep their relative order. Parent links remain authoritative. */
export function moveCatalog(entries: CatalogEntry[], order: string[], key: string, parent: string | null, before: string | null) {
  const source = entries.find(e => e.key === key);
  if (!source) throw new Error("目录或笔记不存在");
  if (parent && !entries.some(e => e.kind === "folder" && e.id === parent)) throw new Error("目标目录不属于此知识库");
  if (source.kind === "folder") {
    let ancestor = parent;
    const seen = new Set<string>();
    while (ancestor) {
      if (ancestor === source.id || seen.has(ancestor)) throw new Error("目录不能移动到自身或下级目录");
      seen.add(ancestor);
      ancestor = entries.find(e => e.kind === "folder" && e.id === ancestor)?.parent_id || null;
    }
  }
  if (before === key) return order;
  if (before && !entries.some(e => e.key === before && e.parent_id === parent)) throw new Error("排序位置已变化，请刷新重试");
  const keys = new Set(entries.map(e => e.key));
  const next = [...new Set([...order, ...entries.map(e => e.key)])].filter(k => keys.has(k) && k !== key);
  const siblings = next.filter(k => entries.find(e => e.key === k)?.parent_id === parent);
  const index = before ? next.indexOf(before) : siblings.length ? next.indexOf(siblings[siblings.length - 1]) + 1 : next.length;
  next.splice(index, 0, key);
  return next;
}
/** Remove a folder while promoting its direct children at the same list position. */
export function unwrapCatalog(entries: CatalogEntry[], order: string[], folderId: string) {
  const folder=entries.find(e=>e.kind === "folder" && e.id === folderId);
  if(!folder)throw new Error("目录不存在");
  const keys=new Set(entries.map(e=>e.key));
  const all=[...new Set([...order,...entries.map(e=>e.key)])].filter(k=>keys.has(k));
  const children=new Set(entries.filter(e=>e.parent_id === folderId).map(e=>e.key));
  const promoted=all.filter(k=>children.has(k));
  const index=all.slice(0,all.indexOf(folder.key)).filter(k=>!children.has(k)).length;
  const next=all.filter(k=>k!==folder.key && !children.has(k));
  next.splice(index,0,...promoted);
  return {parent_id:folder.parent_id,order:next};
}
