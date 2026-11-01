type Book = {id:string;sidebar_pinned?:boolean;sidebar_pinned_at?:string|null};
type Note = {id:string;space_id:string;updated_at:string;archived:boolean};
const time = (value?:string|null) => value ? Date.parse(value) || 0 : 0;

/** Use the captured update times, while immediately dropping unreadable notes. */
export function sidebarLibraries<T extends Book>(books:T[], visibleNotes:Note[], activity:Note[]) {
  const visible = new Map(visibleNotes.filter(note => !note.archived).map(note => [note.id,note.space_id]));
  const updated = new Map<string,number>();
  for (const note of activity) {
    if (note.archived || visible.get(note.id) !== note.space_id) continue;
    const when = time(note.updated_at);
    if (when > (updated.get(note.space_id) || 0)) updated.set(note.space_id,when);
  }
  const fixed = books.filter(book => book.sidebar_pinned).sort((a,b) => time(a.sidebar_pinned_at)-time(b.sidebar_pinned_at) || a.id.localeCompare(b.id));
  const recent = books.filter(book => !book.sidebar_pinned && updated.has(book.id))
    .sort((a,b) => updated.get(b.id)!-updated.get(a.id)! || a.id.localeCompare(b.id))
    .slice(0,Math.max(0,5-fixed.length));
  return [...fixed,...recent];
}
