import { t as translateUI } from "@anote/i18n";
import React from "react";
import { Icon } from "./icons";
import { useSidebarVisibility } from "./sidebar-visibility";

type Note = {id:string;title:string;folder_name?:string};
type Entry = {id:string;kind:"folder"|"note";parent_id:string|null};

/** Flatten the library's saved directory order; never sort by editing activity. */
function orderedNotes(notes:Note[],entries:Entry[]) {
  const byId = new Map(notes.map(note => [note.id,note]));
  const children = new Map<string|null,Entry[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parent_id) || [];
    siblings.push(entry);
    children.set(entry.parent_id,siblings);
  }
  const result:Note[] = [], visited = new Set<string>();
  function visit(parent:string|null) {
    for (const entry of children.get(parent) || []) {
      const key = `${entry.kind}:${entry.id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (entry.kind === "folder") visit(entry.id);
      else if (byId.has(entry.id)) {
        result.push(byId.get(entry.id)!);
        byId.delete(entry.id);
      }
    }
  }
  visit(null);
  // Newly created or archived notes may not be in the current catalog yet.
  return [...result,...[...byId.values()].sort((a,b) => a.id.localeCompare(b.id))];
}

export function LibraryNoteList({serverURL,userId,library,notes,entries,selected,onSelect,onLibrary}: {
  serverURL:string;userId:string;library:{id:string;name:string};notes:Note[];entries:Entry[];
  selected:string;onSelect:(note:Note)=>void;onLibrary:()=>void;
}) {
  const [collapsed,setCollapsed] = useSidebarVisibility(serverURL,userId,"note-list");
  return <aside className={"library-note-list"+(collapsed?" is-collapsed":"")} aria-label={translateUI("同库笔记")}>
    <header>
      <button className="note-list-library" hidden={collapsed} onClick={onLibrary} title={library.name}><span>{library.name}</span></button>
      <button className="note-list-toggle" aria-label={collapsed?translateUI("显示笔记列表"):translateUI("隐藏笔记列表")} title={collapsed?translateUI("显示笔记列表"):translateUI("隐藏笔记列表")} aria-expanded={!collapsed} aria-controls="library-note-titles" onClick={()=>setCollapsed(!collapsed)}>
        <Icon name={collapsed?"list-expand":"list-collapse"} size={18}/>
      </button>
    </header>
    <nav id="library-note-titles" aria-label={translateUI("知识库笔记列表")} hidden={collapsed}>
      {orderedNotes(notes,entries).map(note => <button key={note.id} className="note-list-item" aria-current={note.id===selected?"page":undefined} title={[note.title,note.folder_name].filter(Boolean).join(" · ")} onClick={()=>onSelect(note)}>
        <Icon name="file" size={15}/><span>{note.title || translateUI("未命名笔记")}</span>
      </button>)}
    </nav>
  </aside>;
}
