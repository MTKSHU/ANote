type Book = {id:string;archived?:boolean;sidebar_pinned?:boolean;sidebar_pinned_at?:string|null};
type Note = {id:string;space_id:string;updated_at:string;archived:boolean};
const sidebarLimit = 3;
const time = (value?:string|null) => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Keep the activity snapshot's order, but use current readable note metadata. */
export function sidebarLibraryNotes<T extends Note>(libraryId:string, visibleNotes:T[], activity:Note[]):T[] {
  const visible = new Map(visibleNotes.filter(note => !note.archived).map(note => [note.id,note]));
  const captured = new Map(activity.filter(note => !note.archived && note.space_id === libraryId).map(note => [note.id,note]));
  return [...captured.values()]
    .filter(note => visible.get(note.id)?.space_id === libraryId)
    .sort((a,b) => time(b.updated_at)-time(a.updated_at) || a.id.localeCompare(b.id))
    .slice(0,sidebarLimit)
    .map(note => visible.get(note.id)!);
}

/** Use the captured update times, while immediately dropping unreadable notes. */
export function sidebarLibraries<T extends Book>(books:T[], visibleNotes:Note[], activity:Note[]) {
  const visible = new Map(visibleNotes.filter(note => !note.archived).map(note => [note.id,note.space_id]));
  const updated = new Map<string,number>();
  for (const note of activity) {
    if (note.archived || visible.get(note.id) !== note.space_id) continue;
    const when = time(note.updated_at);
    if (!updated.has(note.space_id) || when > updated.get(note.space_id)!) updated.set(note.space_id,when);
  }
  books=books.filter(book=>!book.archived);
  const fixed = books.filter(book => book.sidebar_pinned)
    .sort((a,b) => time(a.sidebar_pinned_at)-time(b.sidebar_pinned_at) || a.id.localeCompare(b.id))
    .slice(0,sidebarLimit);
  const recent = books.filter(book => !book.sidebar_pinned && updated.has(book.id))
    .sort((a,b) => updated.get(b.id)!-updated.get(a.id)! || a.id.localeCompare(b.id))
    .slice(0,sidebarLimit-fixed.length);
  return [...fixed,...recent];
}
