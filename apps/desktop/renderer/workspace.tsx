import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import { LanguageSelect } from "./language";
import React, { useEffect, useRef, useState } from "react";
import { Document } from "./document";
import { setPageTitle } from "./page-title";
import { request, type NativeState } from "./native";
import { Icon } from "./icons";
import {BrandLogo} from "./brand";
import {LibraryArchiveDialog,type ArchiveLibrary} from "./library-archive";
import { LibraryPermissionsDialog } from "./members";
import { AccountIdentity } from "./team";
import { PlatformAdmin, ProfileSettings, NicknameSettings } from "./platform";
import { TeamsHub, TeamHome, TeamInvitation } from "./teams";
import { LibraryOutline } from "./library-outline";
import { LibraryNoteList } from "./library-note-list";
import { McpConnections } from "./mcp-connections";
import {LocalMcpSettings} from './local-mcp-settings';
import { Wishes } from "./wishes";
import { Clients } from "../../web/src/clients";
import { OfflineControls } from "./offline-controls";
import { useTheme, AppearanceButton } from "./theme";
import { useDialog, DialogClose } from "./dialog";
import { sidebarLibraries,sidebarLibraryNotes } from "./sidebar-libraries";
import { useSidebarVisibility } from "./sidebar-visibility";
import {NoteLocationPicker} from "./note-move";
import {readWorkspaceLocation, workspaceAddress,type WorkspaceLocation} from "./workspace-location";
import {MyShares} from "./my-shares";
import {LibrarySharing} from "./library-sharing";
import {SidebarGroup} from "./sidebar-group";
import {useSocialBadges,SocialPage} from "./social";
import {WorkspaceLink} from "./workspace-link";
import {useDocumentSessionScope} from './document-session';
import {useWorkspaceScope} from "./workspace-scope";
import {WorkspaceAccountMenu} from "./workspace-account-menu";
import {connectForClientUpdate,useClientUpdateNotification} from "./client-updates";
import "./workspace-account-bar.css";
import {ClientStorage} from "./client-storage";
import {useMobileWorkspace} from "./mobile-layout";
import {MobilePanel} from "./mobile-panel";
type Library = {
  archived?: boolean;
  archived_at?: string|null;
  archive_revision?: string|number;
  id: string;
  created_by?: string;
  creator_name?: string;
  name: string;
  kind: "personal" | "team";
  description: string;
  role: string;
  note_count: number;
  folder_count: number;
  team_id?: string;
  access_mode?: string;
  pinned?: boolean;
  sidebar_pinned?: boolean;
  sidebar_pinned_at?: string | null;
};
type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
};
type Note = {
  id: string;
  space_id: string;
  folder_id: string | null;
  title: string;
  tags: string[];
  archived: boolean;
  created_by: string;
  author_name?: string;
  visibility: string;
  role: string;
  updated_at: string;
  space_name: string;
  space_kind: string;
  folder_name: string;
  collaboration_role?: string;
  team_id?: string | null;
};
type Dialog = {
  kind:
    | "library-new"
    | "library-edit"
    | "folder-new"
    | "folder-edit"
    | "note-edit";
  id?: string;
  libraryKind?: "personal" | "team";
  name: string;
  description?: string;
  parent?: string;
  tags?: string;
  teamId?: string;
  accessMode?: string;
  pinned?: boolean;
  targetLibraryId?: string;
  movePreview?: any;
};
export function NotebookWorkspace({
  state,
  onLogout,
  onReconnect,
}: {
  state: NativeState;
  onLogout: () => void | Promise<void>;
  onReconnect?: () => void;
}) {
  const documentOwner=useDocumentSessionScope(state);
  const [profile, setProfile] = useState<{ id: string; name: string } | null>(null);
  const [connectionWorkspace,setConnectionWorkspace]=useState(state.connectionWorkspace),[changingWorkspace,setChangingWorkspace]=useState(false);
  useEffect(()=>setConnectionWorkspace(state.connectionWorkspace),[state.connectionWorkspace]);
  const user = { ...state.user!, ...(profile?.id === state.user!.id ? { name: profile.name } : {}) },
    native = state.desktop !== false;
  const personalLibraryLabel = translateUI("{0}的知识库", [user.name]);
  const [initialLocation] = useState(() => readWorkspaceLocation(location.search, native ? state.lastDoc : null, state.personal));
  const [desktopSidebarCollapsed,setDesktopSidebarCollapsed] = useSidebarVisibility(state.serverURL,user.id);
  const {mobile,height:mobileHeight}=useMobileWorkspace();
  const [mobileNavigation,setMobileNavigation]=useState(false),[mobileNotes,setMobileNotes]=useState(false),[newNoteEditing,setNewNoteEditing]=useState("");
  const sidebarCollapsed=mobile||desktopSidebarCollapsed;
  const navigationCollapsed=mobile?!mobileNavigation:sidebarCollapsed;
  function setSidebarCollapsed(value:boolean){if(mobile)setMobileNavigation(!value);else setDesktopSidebarCollapsed(value);}
  function closeMobilePanels(){setMobileNavigation(false);setMobileNotes(false);}
  const [scope,setScope]=useWorkspaceScope(state.serverURL,user.id,initialLocation.scope||initialLocation.teamId,!!state.personal);
  const scopeRef=useRef(scope);scopeRef.current=scope;
  const localNotificationsOnly = native && (!!state.personal || !state.token);
  const socialBadges=useSocialBadges(!!state.personal||state.offline||localNotificationsOnly);
  const clientUpdate=useClientUpdateNotification(state.updates,native);
  const unreadNotifications=(localNotificationsOnly?0:socialBadges.unread)+(clientUpdate&&!clientUpdate.read?1:0);
  useEffect(() => { setProfile(null); }, [state.serverURL, state.user!.id, state.user!.name]);
  const [libraries, setLibraries] = useState<Library[]>([]),
    [notes, setNotes] = useState<Note[]>([]),
    [sidebarActivity, setSidebarActivity] = useState<Note[]>([]),
    [folders, setFolders] = useState<Folder[]>([]),
    [catalog, setCatalog] = useState<{revision:string;items:any[]}>({revision:"0",items:[]}),
    [page, setPage] = useState(initialLocation.page),
    [teamId, setTeamId] = useState(initialLocation.teamId),
    [teamTab, setTeamTab] = useState(initialLocation.teamTab),
    [teamHomeVisit, setTeamHomeVisit] = useState(0),
    [teams, setTeams] = useState<any[]>([]),
    [siteName, setSiteName] = useState(native ? translateUI("服务器笔记") : "ANote"),
    [libraryId, setLibraryId] = useState(initialLocation.libraryId),
    [selected, setSelected] = useState<string | null>(initialLocation.selected),
    [folder, setFolder] = useState<string | null>(initialLocation.folder),
    [homeTab, setHomeTab] = useState(initialLocation.homeTab),
    [query, setQuery] = useState(initialLocation.query),
    [results, setResults] = useState<Note[] | null>(null),
    [archived, setArchived] = useState(initialLocation.archived),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [settings, setSettings] = useState(""),
    [permissionLibraryId,setPermissionLibraryId] = useState("");
  const [folderDeleteTarget,setFolderDeleteTarget] = useState<Folder|null>(null);
  const [sharingLibrary,setSharingLibrary] = useState<string|null>(null);
  const [shareKind,setShareKind] = useState(initialLocation.shareKind),[shareStatus,setShareStatus] = useState(initialLocation.shareStatus);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [pinBusy, setPinBusy] = useState<Record<string, boolean>>({}),
    [error, setError] = useState("");
  const [trashNotes, setTrashNotes] = useState<any[]>([]),
    [trashLibraries, setTrashLibraries] = useState<any[]>([]),
    [trashTeams, setTrashTeams] = useState<any[]>([]),
    [deleteTarget, setDeleteTarget] = useState<{
      id: string;
      title: string;
      kind: "documents" | "spaces" | "teams";
    } | null>(null);
  const [trashTab, setTrashTab] = useState(initialLocation.trashTab);
  const trashGroups = [
    {kind: "teams" as const, label: translateUI("团队"), items: trashTeams},
    {kind: "spaces" as const, label: translateUI("知识库"), items: trashLibraries},
    {kind: "documents" as const, label: translateUI("笔记"), items: trashNotes},
  ];
  const [purgeTarget, setPurgeTarget] = useState<{
      id: string;
      title: string;
      kind: string;
      token: string;
    } | null>(null),
    [purgeName, setPurgeName] = useState("");
  // Initial note metadata fills its context asynchronously; keep an already
  // opened drawer visible while those details arrive. Navigation closes it.
  useEffect(()=>{closeMobilePanels();},[mobile,selected,settings,dialog]);
  useEffect(()=>{if(state.workspaceSwitching||state.storageMigrating||state.backupRestoring)closeMobilePanels();},[state.workspaceSwitching,state.storageMigrating,state.backupRestoring]);
  const navigation = useRef(0),
    loadSequence = useRef(0),
    initialNavigation = useRef<number | null>(0),
    selectedRef = useRef(selected),
    sidebarSnapshot = useRef({scope:"",revision:-1}),
    folderSequence = useRef(0),
    folderContext = useRef("");
  selectedRef.current = selected;
  const [libraryStatus,setLibraryStatus]=useState<"active"|"archived"|"all">("active");
  const [archiveTarget,setArchiveTarget]=useState<ArchiveLibrary|null>(null);
  useEffect(()=>{setArchiveTarget(null);setLibraryStatus("active");},[state.serverURL,user.id]);
  const matchesLibraryStatus=(book:Library)=>libraryStatus==="all"||!!book.archived===(libraryStatus==="archived");
  const library = libraries.find((l) => l.id === libraryId),
    selectedTeam = teams.find((t) => t.id === teamId),
    activeNote = notes.find((n) => n.id === selected),
    canOrganize = !!library && !library.archived && library.role === "admin" && !state.offline,
    canCreateNotes = !!library && !library.archived && ["admin", "editor", "contributor"].includes(library.role) && (!state.offline || state.desktop===true && !!state.offlineStorage?.downloadedLibraryIds?.includes(library.id));
  const scopeTeam=teams.find(team=>team.id===scope);
  const scopeLibraries=libraries.filter(book=>book.kind==="personal"?scope==="personal":book.team_id===scope);
  const writableLibraries=scopeLibraries.filter(book=>!book.archived&&["admin","editor","contributor"].includes(book.role)&&(!state.offline||state.desktop===true&&state.offlineStorage?.downloadedLibraryIds?.includes(book.id)));
  const canCreateInScope=state.offline?writableLibraries.length>0:scope==="personal"||!!scopeTeam&&!scopeTeam.archived&&(writableLibraries.length>0||scopeTeam.role==="admin"||scopeTeam.members_can_create_libraries);
  const bookScope=(book:Pick<Library,"kind"|"team_id">)=>book.kind==="team"?book.team_id||"personal":"personal";
  function hrefFor(patch:Partial<WorkspaceLocation>={}) {
    return workspaceAddress({page:"home",teamId:"",teamTab:"home",libraryId:"",selected:null,folder:null,homeTab:"recent",archived:false,query:"",trashTab:"documents",shareKind:"notes",shareStatus:"active",scope,...patch});
  }
  function report(e: any) {
    setError(translateUI(e.message || translateUI("操作失败")));
  }
  const libraryViewKey = `simple-notes:library-view:${state.serverURL}:${user.id}`;
  const [libraryView,setLibraryView] = useState<"cards"|"list">(() => {try{return localStorage.getItem(libraryViewKey) === "list" ? "list" : "cards";}catch{return "cards";}});
  useEffect(() => {try{setLibraryView(localStorage.getItem(libraryViewKey) === "list" ? "list" : "cards");}catch{setLibraryView("cards");}},[libraryViewKey]);
  function chooseLibraryView(view:"cards"|"list") {setLibraryView(view);try{localStorage.setItem(libraryViewKey,view);}catch{}}
  const appearance = useTheme(state, report);
  const settingsOpen = !!settings;
  const settingsDialog = useDialog(() => setSettings(""),{open:settingsOpen});
  const editDialog = useDialog<HTMLFormElement>(() => setDialog(null),{open:!!dialog,disabled:busy});
  const deleteDialog = useDialog(() => setDeleteTarget(null),{open:!!deleteTarget,disabled:busy});
  const purgeDialog = useDialog<HTMLFormElement>(() => setPurgeTarget(null),{open:!!purgeTarget,disabled:busy});
  const folderDeleteDialog = useDialog<HTMLFormElement>(() => setFolderDeleteTarget(null),{open:!!folderDeleteTarget,disabled:busy});
  useEffect(() => {
    const url = workspaceAddress({page,teamId,teamTab,libraryId,selected,folder,homeTab,archived,query,trashTab,shareKind,shareStatus,scope});
    if (location.pathname + location.search !== url) history.replaceState(null, "", url);
  }, [page,teamId,teamTab,libraryId,selected,folder,homeTab,archived,query,trashTab,shareKind,shareStatus,scope]);
  function address(note: string | null, space?: string) {
    if (native) void window.anote.selectDocument(note,state.serverURL+"|"+user.id);
  }
  async function refresh() {
    const sequence = ++loadSequence.current,
      revision = navigation.current;
    try {
      const [
        books,
        active,
        archive,
        teamValues,
        site,
        trashed,
        trashedLibraries,
        trashedTeams,
      ] = await Promise.all([
        request("spaces"),
        request("documents"),
        request("documents?archived=true"),
        request("teams"),
        request("platform/public"),
        request("trash/documents"),
        request("trash/spaces"),
        request("trash/teams"),
      ]);
      if (sequence !== loadSequence.current) return;
      setLibraries(books);
      setTrashNotes(trashed);
      setTrashLibraries(trashedLibraries);
      setTrashTeams(trashedTeams);
      setTeams(teamValues);
      if(scopeRef.current!=="personal"&&!teamValues.some((team:any)=>team.id===scopeRef.current)){setScope("personal");if(!selectedRef.current){setTeamId("");setPage("home");}}
      setSiteName(site.site_name);
      setPageTitle(native ? "ANote" : site.site_name);
      setNotes([...active, ...archive]);
      const activityScope = state.serverURL + "|" + user.id;
      if (sidebarSnapshot.current.scope !== activityScope || !selectedRef.current || (sidebarSnapshot.current.revision !== navigation.current && revision === navigation.current)) {
        setSidebarActivity(active);
        sidebarSnapshot.current = {scope:activityScope,revision:navigation.current};
      }
      // A focus/metadata refresh may supersede the first request. The latest
      // response must still restore the initial note's library context.
      if (
        initialNavigation.current === revision &&
        navigation.current === revision
      ) {
        const id = selectedRef.current;
        if (id) {
          let note = [...active, ...archive].find((n: any) => n.id === id);
          if (!note) {
            try {
              note = await request("documents/" + id);
            } catch (e) {
              if (
                navigation.current === revision &&
                sequence === loadSequence.current
              ) {
                setSelected(null);
                setLibraryId("");
                setPage("home");
                address(null);
              }
              report(e);
            }
          }
          if (
            navigation.current !== revision ||
            sequence !== loadSequence.current
          )
            return;
          if (note && books.some((b: any) => b.id === note.space_id)) {
            setLibraryId(note.space_id);
            setScope(bookScope(books.find((b:any)=>b.id===note.space_id)!));
            setPage("library");
            setArchived(!!note.archived);
          }
        } else if (libraryId && page === "library") {
          if (books.some((b: any) => b.id === libraryId)) {setPage("library");setScope(bookScope(books.find((b:any)=>b.id===libraryId)!));}
          else {setLibraryId("");setPage("personal");setFolder(null);}
        } else if (teamId && ["teams","team"].includes(page) && !teamValues.some((t:any) => t.id === teamId)) {
          setTeamId("");setTeamTab("home");setPage("teams");
        } else if(teamId&&["teams","team"].includes(page)) {
          setScope(teamId);
        } else if(page==="personal") {
          setScope("personal");
        }
        initialNavigation.current = null;
      }
    } catch (e) {
      report(e);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    initialNavigation.current = navigation.current;
    void refresh();
    return () => { loadSequence.current++; navigation.current++; initialNavigation.current=null; };
  }, [state.serverURL, user.id]);
  useEffect(() => {
    const changed = () => void refresh();
    window.addEventListener("anote-note-changed", changed);
    window.addEventListener("anote-settings-changed", changed);
    window.addEventListener("focus", changed);
    return () => {
      window.removeEventListener("anote-note-changed", changed);
      window.removeEventListener("anote-settings-changed", changed);
      window.removeEventListener("focus", changed);
    };
  }, [state.serverURL, user.id]);
  useEffect(() => {
    const sequence = ++folderSequence.current,
      context = JSON.stringify([state.serverURL,user.id,library?.id||"",!!state.offline]);
    // Keep the mounted tree during same-library metadata refreshes. Clearing
    // folders temporarily reparents every child note to the root, which
    // recreates its DOM and loses the reader's scroll position.
    if (folderContext.current !== context) {
      folderContext.current = context;
      setFolders([]);
      setCatalog({revision:"0",items:[]});
    }
    if (!library) return;
    Promise.all([request(`spaces/${library.id}/folders`), request(`spaces/${library.id}/catalog`)])
      .then(([v,c]) => {
        if (sequence === folderSequence.current) {setFolders(v);setCatalog(c);}
      })
      .catch(error => {if (sequence === folderSequence.current) report(error);});
    return () => {
      folderSequence.current++;
    };
  }, [library?.id, state.serverURL, user.id, state.offline, notes]);
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      request(`documents?q=${encodeURIComponent(query)}&archived=${archived}`)
        .then((v) => {
          if (current) setResults(v);
        })
        .catch(report);
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, archived]);
  function navigate(next: string, tab = "recent") {
    closeMobilePanels();setNewNoteEditing("");
    navigation.current++;
    setPage(next);
    if(next==="personal")setScope("personal");
    setHomeTab(tab);
    setSelected(null);
    setFolder(null);
    setQuery("");
    setArchived(false);
    address(null);
    void refresh();
  }
  function openLibrary(id: string) {
    closeMobilePanels();setNewNoteEditing("");
    navigation.current++;
    setLibraryId(id);
    const book=libraries.find(book=>book.id===id);if(book)setScope(bookScope(book));
    setPage("library");
    setSelected(null);
    setFolder(null);
    setQuery("");
    setArchived(false);
    address(null, id);
    void refresh();
  }
  function openTeamLibraries(id: string) {
    setScope(id);
    navigate("team");
    setTeamId(id);
    setTeamTab("libraries");
  }
  function openTeam(id: string) {
    setScope(id);
    navigate("teams");
    setTeamId(id);
    setTeamTab("home");
    setTeamHomeVisit((value) => value + 1);
  }
  function askDelete(
    id: string,
    title: string,
    kind: "documents" | "spaces" | "teams" = "documents",
  ) {
    setDialog(null);
    setDeleteTarget({ id, title, kind });
  }
  async function deleteItem() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      const { id, kind } = deleteTarget;
      await request(kind + "/" + id, "DELETE");
      setDeleteTarget(null);
      if (kind === "documents") {
        if (selected === id) {
          setSelected(null);
          setPage(libraryId ? "library" : "home");
          address(null, libraryId);
        }
      } else {
        navigate(kind === "teams" ? "teams" : "personal");
        if (kind === "teams") setTeamId("");
      }
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function restoreItem(kind: string, id: string) {
    setBusy(true);
    try {
      await request(`${kind}/${id}/restore-deleted`, "POST");
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function purgeItem(e: React.FormEvent) {
    e.preventDefault();
    if (!purgeTarget || purgeName !== purgeTarget.title || busy) return;
    setBusy(true);
    try {
      await request(`trash/${purgeTarget.kind}/${purgeTarget.id}`, "DELETE", {
        deletion_token: purgeTarget.token,
      });
      setPurgeTarget(null);
      await refresh();
    } catch (e: any) {
      report(e);
      if ([404, 409].includes(e.status)) {
        setPurgeTarget(null);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  function openFolder(id: string | null) {
    navigation.current++;
    setFolder(id);
    setSelected(null);
    setPage("library");
    setQuery("");
    address(null, libraryId);
    void refresh();
  }
  function openNote(note: Note) {
    const sameNoteList = !!selected && page === "library" && !!library && !!activeNote &&
      activeNote.space_id === library.id && note.space_id === library.id &&
      !!note.archived === !!activeNote.archived &&
      notes.some(current => current.id === note.id && current.space_id === library.id);
    closeMobilePanels();setNewNoteEditing("");
    navigation.current++;
    setSelected(note.id);
    setQuery("");
    if (libraries.some((l) => l.id === note.space_id)) {
      setScope(bookScope(libraries.find(book=>book.id===note.space_id)!));
      setLibraryId(note.space_id);
      setPage("library");
      setArchived(note.archived);
    } else {
      setLibraryId("");
      setPage("home");
      setHomeTab("shared");
    }
    address(note.id);
    // The document reauthorizes itself on every open. Switching among known
    // notes in the visible library does not invalidate the library catalog.
    if (!sameNoteList) void refresh();
  }
  async function createNote(targetBook?: Library,targetFolder?:string|null) {
    if (busy) return;
    const revision = ++navigation.current;
    setBusy(true);
    try {
      let book =
        targetBook ||
        (page === "library"
          ? library
          : writableLibraries[0]);
      if (!book) {
        if(state.offline)throw new Error(translateUI("请先下载一个可编辑知识库的离线副本"));
        if(!canCreateInScope)throw new Error(translateUI("当前空间没有可创建笔记的知识库"));
        book = await request("spaces", "POST", {kind:scope==="personal"?"personal":"team",team_id:scope==="personal"?undefined:scope,name:translateUI("默认知识库"),description:""});
      }
      const note = await request("documents", "POST", {
        space_id: book!.id,
        folder_id:targetFolder!==undefined?targetFolder:
          page === "library" || targetBook?.id === libraryId ? folder : null,
        title: translateUI("未命名笔记"),
      });
      await refresh();
      if (navigation.current !== revision) return;
      setLibraryId(book!.id);
      setScope(bookScope(book!));
      setPage("library");
      setSelected(note.id);
      setNewNoteEditing(note.id);closeMobilePanels();
      setArchived(false);
      setQuery("");
      address(note.id);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  function newFolder(parent: string | null = folder) {
    setDialog({ kind: "folder-new", name: "", parent: parent || "" });
  }
  async function moveNote(id: string, target: string | null) {
    try {
      await request(`documents/${id}`, "PATCH", { folder_id: target });
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  function drop(e: React.DragEvent, target: string | null) {
    const id = e.dataTransfer.getData("application/x-academic-note");
    if (!id || !canCreateNotes || notes.find(n => n.id === id)?.role !== "admin") return;
    e.preventDefault();
    if (notes.find((n) => n.id === id)?.space_id !== libraryId) {
      setError(translateUI("请在同一知识库内移动笔记"));
      return;
    }
    void moveNote(id, target);
  }
  function editNote(note: Note) {
    setDialog({
      kind: "note-edit",
      id: note.id,
      name: note.title,
      parent: note.folder_id || "",
      targetLibraryId: note.space_id,
      tags: (note.tags || []).join(", "),
    });
  }
  async function reorderNoteList(entry:{kind:"folder"|"note";id:string},parent:string|null,before:string|null) {
    try {setCatalog(await request(`spaces/${libraryId}/catalog`,"PATCH",{revision:catalog.revision,...entry,parent_id:parent,before}));await refresh();}
    catch(error){report(error);try{setCatalog(await request(`spaces/${libraryId}/catalog`));}catch(error){report(error);}}
  }
  async function saveDialog(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === "library-new") {
        const value = await request("spaces", "POST", {
          name: dialog.name,
          description: dialog.description || "",
          kind: dialog.libraryKind,
          team_id: dialog.teamId || teams[0]?.id,
          access_mode: dialog.accessMode || "team",
        });
        await refresh();
        setDialog(null);
        openLibrary(value.id);
        return;
      }
      if (dialog.kind === "library-edit")
        await request("spaces/" + dialog.id, "PATCH", {
          access_mode: dialog.accessMode,
          ...(dialog.libraryKind === "team" && teams.find(t => t.id === dialog.teamId)?.role === "admin" ? {pinned: !!dialog.pinned} : {}),
          name: dialog.name,
          description: dialog.description || "",
        });
      if (dialog.kind === "folder-new")
        await request(`spaces/${libraryId}/folders`, "POST", {
          name: dialog.name,
          parent_id: dialog.parent || null,
        });
      if (dialog.kind === "folder-edit")
        await request(`spaces/${libraryId}/folders/${dialog.id}`, "PATCH", {
          name: dialog.name,
          parent_id: dialog.parent || null,
        });
      if (dialog.kind === "note-edit") {
        const note = notes.find((n) => n.id === dialog.id);
        if(note&&dialog.targetLibraryId&&dialog.targetLibraryId!==note.space_id){
          if(!dialog.movePreview){
            const preview=await request(`documents/${note.id}/move-preview`,"POST",{library_id:dialog.targetLibraryId,folder_id:dialog.parent||null,visibility:note.visibility==="team"?"team":"private",title:dialog.name,tags:(dialog.tags||"").split(/[,，]/).map(v=>v.trim()).filter(Boolean)});
            setDialog({...dialog,movePreview:preview});return;
          }
          try{
            const value=await request(`documents/${note.id}/move`,"POST",dialog.movePreview);
            await refresh();setDialog(null);
            if(selected===note.id)openNote({...note,space_id:value.library_id,folder_id:value.folder_id,visibility:value.visibility,title:dialog.name,tags:dialog.movePreview.tags});
            window.dispatchEvent(new Event("anote-note-changed"));return;
          }catch(error){setDialog({...dialog,movePreview:undefined});throw error;}
        }
        await request(`documents/${dialog.id}`, "PATCH", {
          title: dialog.name,
          tags: (dialog.tags || "")
            .split(/[,，]/)
            .map((v) => v.trim())
            .filter(Boolean),
          ...(note?.role === "admin" && ["admin","editor","contributor"].includes(libraries.find(l=>l.id===note.space_id)?.role||"")
            ? { folder_id: dialog.parent || null }
            : {}),
        });
        window.dispatchEvent(new Event("anote-note-changed"));
      }
      if (dialog.kind.startsWith("folder"))
        setFolders(await request(`spaces/${libraryId}/folders`));
      await refresh();
      setDialog(null);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const branchIds = (id: string): Set<string> => {
    const ids = new Set([id]);
    let added = true;
    while (added) {
      added = false;
      for (const f of folders)
        if (f.parent_id && ids.has(f.parent_id) && !ids.has(f.id)) {
          ids.add(f.id);
          added = true;
        }
    }
    return ids;
  };
  const source = (results ?? notes).filter(n=>n.archived===archived).filter(note=>page!=="home"||homeTab!=="recent"||!(note as any).library_archived&&!libraries.some(book=>book.id===note.space_id&&book.archived));
  const showingTeamHome=page==="home"&&scope!=="personal"&&homeTab==="recent";
  const inScope=(note:Note)=>scope==="personal"?note.space_kind==="personal":(note.team_id||libraries.find(book=>book.id===note.space_id)?.team_id)===scope;
  const visible=source.filter(note=>page==="library"
    ?note.space_id===libraryId&&(!folder||branchIds(folder).has(note.folder_id||""))
    :inScope(note)&&(homeTab!=="shared"||note.created_by!==user.id&&(!!note.collaboration_role||libraries.some(book=>book.id===note.space_id&&book.kind==="personal"&&book.created_by!==user.id))));
  const folderPath: Folder[] = [];
  const showNoteAuthors=(page==="library"&&library?.kind==="team")||(page==="home"&&!state.personal);
  let ancestor = folders.find((f) => f.id === folder);
  while (ancestor && !folderPath.some((item) => item.id === ancestor!.id)) {
    folderPath.unshift(ancestor);
    ancestor = folders.find((f) => f.id === ancestor!.parent_id);
  }
  function noteRow(note: Note, tree = false) {
    return (
      <div
        key={note.id}
        className={
          (tree ? "catalog-note" : "note-table-row") +
          (selected === note.id ? " selected" : "")
        }
        draggable={
          page === "library" &&
          canCreateNotes &&
          note.role === "admin"
        }
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-academic-note", note.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <button className="note-open" onClick={() => openNote(note)}>
          <Icon name="file" />
          <span>
            <strong>{note.title}</strong>
            {!tree && (
              <small>
                {note.space_name || library?.name}
                {note.folder_name ? " / " + note.folder_name : ""}
              </small>
            )}
          </span>
        </button>
        {!tree && (
          <>
            {showNoteAuthors && <span className="note-author" title={note.author_name || (note.created_by === user.id ? user.name : translateUI("未知作者"))}>{note.author_name || (note.created_by === user.id ? user.name : translateUI("未知作者"))}</span>}
            <span className="note-visibility">
              {note.visibility === "team"
                ? translateUI("团队可见")
                : note.created_by === user.id
                  ? translateUI("我的笔记")
                  : translateUI("指定共享")}
            </span>
            <time>
              {note.updated_at
                ? new Date(note.updated_at).toLocaleString(uiLocale(), {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : translateUI("刚刚")}
            </time>
          </>
        )}
        {["admin", "editor"].includes(note.role) && (
          <button
            className="row-more"
            aria-label={translateUI("设置笔记 {0}", [note.title])}
            onClick={() => editNote(note)}
          >
            <Icon name="more" size={16} />
          </button>
        )}
      </div>
    );
  }
  function libraryViewControls() { return <div className="team-view-controls" role="group" aria-label={translateUI("知识库显示方式")}>
                <label className="library-status-filter">{translateUI("状态")}<select aria-label={translateUI("知识库状态")} value={libraryStatus} onChange={event=>setLibraryStatus(event.target.value as typeof libraryStatus)}><option value="active">{translateUI("正常")}</option><option value="archived">{translateUI("已归档")}</option><option value="all">{translateUI("全部")}</option></select></label>
                <button aria-label={translateUI("卡片视图")} aria-pressed={libraryView === "cards"} onClick={() => chooseLibraryView("cards")}><Icon name="table" />{translateUI("卡片")}</button>
                <button aria-label={translateUI("列表视图")} aria-pressed={libraryView === "list"} onClick={() => chooseLibraryView("list")}><Icon name="list" />{translateUI("列表")}</button>
              </div>; }
  function renderLibraries(kind: "personal" | "team") { return (<>
              <div className={"library-grid " + (libraryView === "list" ? "list-view" : "cards-view")}>
                {libraries
                  .filter(
                    (l) =>
                      l.kind === kind && (kind !== "personal" || !l.created_by || l.created_by === user.id) &&
                      (kind !== "team" || l.team_id === teamId) && matchesLibraryStatus(l),
                  )
                  .map((l) => (
                    <article className="library-card" key={l.id}>
                      <button
                        className={"library-open" + (l.kind === "team" ? " has-creator" : "")}
                        onClick={() => openLibrary(l.id)}
                      >
                        <span className={"library-glyph " + l.kind}>
                          <Icon name="book" size={25} />
                        </span>
                        <h2>{l.name}</h2>{l.archived&&<span className="library-archive-badge"><Icon name="archive" size={13}/>{translateUI("已归档 · 只读")}</span>}
                        <p>
                          {l.description ||
                            (l.kind === "personal"
                              ? translateUI("个人笔记与研究记录")
                              : translateUI("团队知识与共享笔记"))}
                        </p>
                        {l.kind === "team" && <span className="library-creator" title={l.creator_name || (l.created_by === user.id ? user.name : translateUI("未知创建人"))}>{translateUI("创建人：")}{l.creator_name || (l.created_by === user.id ? user.name : translateUI("未知创建人"))}</span>}
                      </button>
                      <footer>
                        <span>
                          {l.note_count}{translateUI(" 篇笔记 ")}<i /> {l.folder_count}{translateUI(" 个目录 ")}</span>
                        {pinButton(l)}
                        {!state.personal && !l.archived && l.kind === "personal" && l.created_by === user.id && <button title={translateUI("分享知识库")} aria-label={translateUI("分享知识库 {0}", [l.name])} onClick={()=>setSharingLibrary(l.id)}><Icon name="share" size={16}/>{translateUI("分享")}</button>}
                        {l.role === "admin" && (
                          <button
                            aria-label={translateUI("管理知识库 {0}", [l.name])}
                            onClick={() =>
                              setDialog({
                                kind: "library-edit",
                                id: l.id,
                                name: l.name,
                                description: l.description,
                                accessMode: l.access_mode,
                                libraryKind: l.kind,
                                teamId: l.team_id,
                                pinned: l.pinned,
                              })
                            }
                          >{translateUI("管理 ")}<Icon name="more" size={18} />
                          </button>
                        )}
                      </footer>
                    </article>
                  ))}
                {!libraries.some(
                  (l) =>
                    l.kind === kind && (kind !== "personal" || !l.created_by || l.created_by === user.id) &&
                    (kind !== "team" || l.team_id === teamId) && matchesLibraryStatus(l),
                ) && (
                  <div className="academic-empty">
                    <Icon name="book" size={42} />
                    <h3>
                      {libraryStatus==="archived"?translateUI("暂无已归档知识库"):kind === "personal"
                        ? translateUI("建立你的第一个知识库")
                        : translateUI("暂无团队知识库")}
                    </h3>
                    <p>
                      {libraryStatus==="archived"?translateUI("归档的知识库会保留内容，可随时恢复。"):kind === "personal"
                        ? translateUI("可以按课题、项目或研究方向分别整理。")
                        : translateUI("由管理员创建知识库并邀请成员。")}
                    </p>
                  </div>
                )}
              </div></>
  ); }
  function renderNotes() {
    return (
      <div className={"note-table" + (showNoteAuthors ? " has-authors" : "")} aria-label={translateUI("笔记列表")}>
        <div className="note-table-head">
          <span>{translateUI("笔记")}</span>
          {showNoteAuthors && <span className="note-author-heading">{translateUI("作者")}</span>}
          <span className="note-visibility-heading">{translateUI("可见范围")}</span>
          <span className="note-updated-heading">{translateUI("最近更新")}</span>
          <span />
        </div>
        {visible.map((n) => noteRow(n))}
        {!visible.length && (
          <div className="academic-empty">
            <Icon name={query ? "search" : "file"} size={36} />
            <h3>
              {query
                ? translateUI("没有找到匹配的笔记")
                : archived
                  ? translateUI("暂无归档笔记")
                  : homeTab === "shared" && page === "home"
                    ? translateUI("暂无分享给你的笔记")
                    : translateUI("这里还没有笔记")}
            </h3>
            <p>
              {query
                ? translateUI("试试其他标题、正文或标签。")
                : translateUI("笔记可以放进目录，也可以直接保存在知识库中。")}
            </p>
            {!archived && homeTab !== "shared" && (
              <button
                className="primary"
                disabled={busy || (page === "library" && !canCreateNotes) || (page === "home" && !canCreateInScope)}
                onClick={() => void createNote()}
              >{translateUI("新建笔记 ")}</button>
            )}
          </div>
        )}
      </div>
    );
  }
  async function toggleSidebarPin(book: Library) {
    if (pinBusy[book.id] || state.offline) return;
    setPinBusy((v) => ({ ...v, [book.id]: true }));
    try {
      const value = await request(
        "spaces/" + book.id + "/sidebar-pin",
        "PATCH",
        { pinned: !book.sidebar_pinned },
      );
      setLibraries((items) =>
        items.map((item) =>
          item.id === book.id ? { ...item, ...value } : item,
        ),
      );
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setPinBusy((v) => ({ ...v, [book.id]: false }));
    }
  }
  function pinButton(book: Library) {
    if(book.archived)return null;
    return (
      <button
        className={"sidebar-pin" + (book.sidebar_pinned ? " pinned" : "")}
        title={book.sidebar_pinned ? translateUI("取消固定到侧栏") : translateUI("固定到侧栏")}
        aria-label={
          (book.sidebar_pinned ? translateUI("取消固定 ") : translateUI("固定到侧栏 ")) + book.name
        }
        aria-pressed={!!book.sidebar_pinned}
        disabled={state.offline || pinBusy[book.id]}
        onClick={() => void toggleSidebarPin(book)}
      >
        <Icon name="pin" size={16} />
      </button>
    );
  }
  function knowledgeLibrary(book: Library) {
    return (
      <div
        className={
          "sidebar-library-row" +
          (libraryId === book.id && page === "library" ? " active" : "")
        }
        key={book.id}
        data-knowledge-library={book.id}
      >
        <WorkspaceLink
          className="sidebar-library"
          href={hrefFor({page:"library",libraryId:book.id,scope:bookScope(book)})}
          title={book.name + (book.sidebar_pinned ? translateUI(" · 已固定") : translateUI(" · 最近更新"))}
          onNavigate={() => openLibrary(book.id)}
        >
          <Icon name="book" size={16} />
          <span>{book.name}</span>
        </WorkspaceLink>
        {pinButton(book)}
      </div>
    );
  }
  function libraryRecent(book:Library) {return sidebarLibraryNotes(book.id,notes,sidebarActivity);}
  const sharedPersonalLibraries=scopeLibraries.filter(book=>book.kind==="personal"&&book.created_by&&book.created_by!==user.id);
  const connectionLabel = state.personal || !state.serverURL ? translateUI("连接服务器") : translateUI("切换服务器");
  function connectForUpdate(){setSettings("");connectForClientUpdate(onReconnect);}
  function openClientUpdate(){clientUpdate?.markRead();if(clientUpdate?.state.needsAuth&&clientUpdate.state.status!=="ready")connectForUpdate();else setSettings("clients");}
  function chooseScope(value:string) {setScope(value);setTeamId("");if(value!=="personal")setShareKind("notes");navigate("home",page==="home"?homeTab:"recent");}
  async function checkUpdatesShortcut(){
    if(!native){window.dispatchEvent(new Event("anote-check-web-update"));return;}
    setSettings("clients");
    try{await window.anote?.checkUpdates?.();}catch(error){report(error);}
  }
  async function openServerWorkspace(value:string,nextPage:"home"|"friends"|"teams"="home"){
    if(!state.personal){
      if(nextPage==="home")chooseScope(value);
      else{if(nextPage==="teams")setTeamId("");navigate(nextPage);}
      return;
    }
    setChangingWorkspace(true);
    try{
      const connected=await window.anote?.openServerWorkspace?.({scope:value,page:nextPage});
      if(!connected)window.dispatchEvent(new CustomEvent("anote-connect-server",{detail:{workspace:{scope:value,page:nextPage}}}));
    }finally{setChangingWorkspace(false);}
  }
  async function openLocalWorkspace(){
    if(state.personal)return;
    setChangingWorkspace(true);
    try{await (window.anote.openLocalWorkspace?.()||window.anote.enterPersonal());}
    finally{setChangingWorkspace(false);}
  }
  async function refreshWorkspaceChoices(){
    if(native&&state.personal&&window.anote.serverWorkspaces)setConnectionWorkspace(await window.anote.serverWorkspaces());
  }
  const accountTools=<div className="workspace-account-tools" role="group" aria-label={translateUI("用户与消息")} inert={mobile&&(mobileNavigation||mobileNotes)}>
    {(!state.personal||native)&&<WorkspaceLink className={"sidebar-notifications"+(page==="notifications"?" active":"")+(unreadNotifications>0?" has-unread":"")} href={hrefFor({page:"notifications"})} onNavigate={()=>navigate("notifications")} aria-label={translateUI("消息通知")} title={translateUI("消息通知{0}", [(unreadNotifications?translateUI(" · {0} 条未读", [unreadNotifications]):"")])}><Icon name="bell" size={19}/>{unreadNotifications>0&&<span className="notification-dot" aria-label={translateUI("{0}条未读", [unreadNotifications])}/>}</WorkspaceLink>}
    <WorkspaceAccountMenu name={user.name} email={user.email} local={!!state.personal} requests={socialBadges.requests}
      native={native} scope={scope} teams={state.personal?connectionWorkspace?.teams||[]:teams} onScope={value=>openServerWorkspace(value)} onLocalMode={openLocalWorkspace}
      switchingWorkspace={changingWorkspace} onWorkspaceOpen={refreshWorkspaceChoices} onWorkspaceError={report}
      onFriends={()=>void openServerWorkspace("personal","friends").catch(report)} onTeams={()=>void openServerWorkspace("personal","teams").catch(report)} onSettings={()=>setSettings("general")} onLogout={()=>void Promise.resolve(onLogout()).catch(report)}
      onCheckUpdates={()=>void checkUpdatesShortcut()}
      href={(nextPage,team)=>hrefFor({page:nextPage,teamId:nextPage==="home"?"":team||"",scope:nextPage==="home"?team||scope:scope,homeTab:page==="home"?homeTab:"recent"})}/>
  </div>;
  const bannerScope=state.personal?translateUI("本地模式"):scope==="personal"?translateUI("个人"):scopeTeam?.name||translateUI("团队空间");
  const bannerPage=selected?activeNote?.title||translateUI("笔记"):page==="home"?(homeTab==="shared"?translateUI("分享给我"):homeTab==="outgoing"?translateUI("我的分享"):scope==="personal"?translateUI("首页"):translateUI("团队首页")):page==="library"?library?.name||translateUI("知识库"):page==="personal"?translateUI("全部知识库"):page==="team"?selectedTeam?.name||translateUI("团队知识库"):page==="teams"?selectedTeam?.name||translateUI("团队管理"):({friends:translateUI("好友管理"),notifications:translateUI("消息通知"),wishes:translateUI("许愿池"),trash:translateUI("回收站")} as Record<string,string>)[page]||translateUI("首页");
  const compactNavigation=null;
  useEffect(()=>{
    if(!mobile)return;
    const back=(event:Event)=>{
      if(event.defaultPrevented||document.querySelector('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]'))return;
      const menus=[...document.querySelectorAll<HTMLDetailsElement>('details[open][data-workspace-identity-menu],details.note-more[open]')];
      if(menus.length){event.preventDefault();for(const menu of menus)menu.open=false;return;}
      if(selected){event.preventDefault();if(library&&activeNote?.space_id===library.id)openLibrary(library.id);else navigate("home","shared");}
      else if(page!=="home"){event.preventDefault();navigate("home");}
    };
    window.addEventListener("anote:mobile-back",back);return()=>window.removeEventListener("anote:mobile-back",back);
  },[mobile,selected,page,library?.id,activeNote?.space_id]);
  return (
    <div className={"academic-workspace workspace-account-layout" + (sidebarCollapsed ? " academic-focus" : "")+(mobile?" workspace-mobile":"")} style={mobile?{"--mobile-workspace-height":mobileHeight+"px"} as React.CSSProperties:undefined} inert={!!state.workspaceSwitching||!!state.storageMigrating||!!state.backupRestoring}>
      <header className="workspace-top-banner" aria-label={translateUI("工作空间顶栏")} inert={mobile&&(mobileNavigation||mobileNotes)}>
      <div className="workspace-corner-navigation" role="group" aria-label={translateUI("导航与品牌")} inert={mobile&&(mobileNavigation||mobileNotes)}>
        <button className="academic-sidebar-toggle" aria-label={navigationCollapsed?translateUI("展开侧边栏"):translateUI("收起侧边栏")} title={navigationCollapsed?translateUI("展开侧边栏"):translateUI("收起侧边栏")} aria-expanded={!navigationCollapsed} aria-controls="workspace-sidebar" onClick={()=>setSidebarCollapsed(!navigationCollapsed)}><Icon name={navigationCollapsed?"panel-open":"panel-close"} size={18}/></button>
        <WorkspaceLink className={sidebarCollapsed?"sidebar-collapsed-home":"academic-brand"} href={hrefFor()} aria-label={sidebarCollapsed?translateUI("首页"):native?"ANote":siteName} title={sidebarCollapsed?translateUI("首页"):native?"ANote":siteName} onNavigate={()=>navigate("home")}>
          {sidebarCollapsed?<Icon name="home" size={18}/>:<><span className="brand-logo-frame"><BrandLogo size={30}/></span><strong>{native?"ANote":siteName}</strong></>}
        </WorkspaceLink>
      </div>
      <nav className="workspace-banner-context" aria-label={translateUI("当前位置")}>
        <WorkspaceLink href={hrefFor()} onNavigate={()=>navigate("home")} title={bannerScope}>{bannerScope}</WorkspaceLink>
        <Icon name="chevron" size={13}/>
        {selected&&library&&<><WorkspaceLink href={hrefFor({page:"library",libraryId:library.id})} onNavigate={()=>openLibrary(library.id)} title={library.name}>{library.name}</WorkspaceLink><Icon name="chevron" size={13}/></>}
        <span aria-current="page" title={bannerPage}>{bannerPage}</span>
      </nav>
      {accountTools}
      </header>
      <MobilePanel mobile={mobile} open={mobile?mobileNavigation:!sidebarCollapsed} label={translateUI("知识库导航")} closeLabel={translateUI("关闭导航")} onClose={()=>setMobileNavigation(false)}>
        <aside
          className="academic-sidebar"
          id="workspace-sidebar"
          aria-label={translateUI("知识库侧边栏")}
        >
          <nav className="academic-navigation" aria-label={translateUI("主导航")}>
            <WorkspaceLink
              className={
                page === "home" ? "active" : ""
              }
              href={hrefFor()}
              title={translateUI("首页")}
              onNavigate={() => navigate("home")}
            >
              <Icon name="home" />
              <span>{translateUI("首页")}</span>
            </WorkspaceLink>
            {!state.personal && (
              <>
                <WorkspaceLink href={hrefFor({page:"wishes"})} className={page === "wishes" ? "active" : ""} title={translateUI("许愿池")} onNavigate={() => navigate("wishes")}><Icon name="wish"/><span>{translateUI("许愿池")}</span></WorkspaceLink>
              </>
            )}
          </nav>
          <div className="academic-sidebar-content">
            <nav className="academic-navigation sidebar-library-navigation" aria-label={translateUI("知识库导航")}>
              <WorkspaceLink href={scope==="personal"?hrefFor({page:"personal"}):hrefFor({page:"teams",teamId:scope,teamTab:"libraries"})} className={(scope==="personal"?page==="personal":page==="teams"&&teamId===scope&&teamTab==="libraries")?"active":""} onNavigate={()=>scope==="personal"?navigate("personal"):openTeamLibraries(scope)}><Icon name="book"/><span>{translateUI("全部知识库")}</span></WorkspaceLink>
            </nav>
            <section className="knowledge-current-group" data-sidebar-group={scope} aria-label={translateUI("当前空间知识库")}>
                {sidebarLibraries(scopeLibraries,notes,sidebarActivity).map(book=><section className="sidebar-book" key={book.id} aria-label={translateUI("{0}的最近笔记", [book.name])}>
                  <SidebarGroup serverURL={state.serverURL} userId={user.id} name={"library:"+book.id} label={book.name} heading={knowledgeLibrary(book)}>
                    {libraryRecent(book).map(note=><WorkspaceLink key={note.id} href={hrefFor({selected:note.id})} className={"sidebar-library-note"+(selected===note.id?" active":"")} aria-current={selected===note.id?"page":undefined} title={note.title} onNavigate={()=>openNote(note)}><Icon name="file" size={13}/><span>{note.title}</span></WorkspaceLink>)}
                    {!libraryRecent(book).length&&<p className="catalog-empty">{translateUI("暂无笔记")}</p>}
                  </SidebarGroup>
                </section>)}
                {!scopeLibraries.length&&<p className="catalog-empty">{translateUI("暂无知识库")}</p>}
            </section>
          </div>
          <nav className="sidebar-bottom-row" aria-label={translateUI("辅助导航")}>
            <WorkspaceLink href={hrefFor({page:"trash"})} title={translateUI("回收站")} className={page === "trash" ? "active" : ""} onNavigate={() => navigate("trash")}>
              <Icon name="trash"/><span>{translateUI("回收站")}</span><small>{trashNotes.length + trashLibraries.length + trashTeams.length || ""}</small>
            </WorkspaceLink>
            <AppearanceButton appearance={appearance} />
          </nav>
        </aside>
      </MobilePanel>
      <main className="academic-main" inert={mobile&&(mobileNavigation||mobileNotes)}>
        {selected ? (
          <div className="note-workspace">
          {library && activeNote?.space_id === library.id && <MobilePanel mobile={mobile} open={!mobile||mobileNotes} label={translateUI("同库笔记")} closeLabel={translateUI("关闭笔记列表")} onClose={()=>setMobileNotes(false)}><LibraryNoteList
            compact={mobile}
            serverURL={state.serverURL} userId={user.id} library={library}
            notes={notes.filter(note => note.space_id === library.id && !!note.archived === !!activeNote.archived)}
            folders={folders} entries={catalog.items} selected={selected}
            canCreate={canCreateNotes&&!activeNote.archived&&!busy} canOrganize={canOrganize&&!activeNote.archived}
            onCreate={()=>void createNote(library,activeNote.folder_id||null)} onSettings={note=>{const current=notes.find(item=>item.id===note.id);if(current)editNote(current);}} onMove={reorderNoteList}
            onNewFolder={parent=>newFolder(parent)} onFolderSettings={item=>setDialog({kind:"folder-edit",id:item.id,name:item.name,parent:item.parent_id||""})}
            onSelect={note => { const target = notes.find(item => item.id === note.id); if (target) openNote(target); }}
            onLibrary={() => openLibrary(library.id)}
          /></MobilePanel>}
          <Document
            key={`${documentOwner}:${selected}`}
            state={{ ...state, user }}
            id={selected}
            title={activeNote?.title || translateUI("笔记")}
            compact={mobile}
            initiallyEditing={newNoteEditing===selected}
            onNotes={mobile&&library&&activeNote?.space_id===library.id?()=>setMobileNotes(true):undefined}
            notesOpen={mobileNotes}
            noteTargets={notes}
            onOpenNoteLink={id=>{if(!/^[-\w]{1,80}$/.test(id))return;void request("documents/"+id).then(note=>{setNotes(current=>current.some(item=>item.id===note.id)?current:[...current,note]);openNote(note);}).catch(report);}}
            headerControls={compactNavigation}
            onDetails={
              activeNote
                ? (value) => editNote({ ...activeNote, ...value })
                : undefined
            }
            onBack={() =>
              library && activeNote?.space_id === library.id
                ? openLibrary(library.id)
                : navigate("home", "shared")
            }
            onDelete={
              activeNote?.role === "admin"
                ? () => askDelete(activeNote.id, activeNote.title)
                : undefined
            }
          />
          </div>
        ) : page==="notifications"&&(!state.personal||native)||page==="friends"&&!state.personal ? (
          <SocialPage key={page} page={page} headerControls={compactNavigation} userId={user.id} offline={state.offline} localOnly={localNotificationsOnly} clientUpdate={clientUpdate} onClientUpdate={openClientUpdate} onOpenNote={id=>{void request("documents/"+id).then(openNote).catch(report);}} onFriends={()=>navigate("friends")} onError={report}/>
        ) : page === "wishes" && !state.personal ? (
          <Wishes user={user} offline={state.offline} headerControls={compactNavigation}/>
        ) : page === "trash" ? (
          <div className="academic-browser trash-browser">
            <header className="academic-page-header">
              <div className="compact-page-heading">{compactNavigation}<div>
                <h1>{translateUI("回收站")}</h1>
                <p>{translateUI("删除满 30 天后自动清理。此前可以恢复，也可手动彻底删除。已撤销的分享链接和邀请不会重新启用。 ")}</p>
              </div></div>
            </header>
            <p className="trash-hint">{translateUI("团队、知识库删除后，其下内容一同隐藏。先恢复团队，再恢复单独删除的知识库或笔记。 ")}</p>
            <nav className="management-tabs trash-tabs" role="tablist" aria-label={translateUI("回收站分类")}>
              {trashGroups.map((group, index) => <button key={group.kind} role="tab" id={"trash-tab-" + group.kind} aria-controls={"trash-panel-" + group.kind} aria-selected={trashTab === group.kind} tabIndex={trashTab === group.kind ? 0 : -1} className={trashTab === group.kind ? "active" : ""} onClick={() => setTrashTab(group.kind)} onKeyDown={event => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const next = event.key === "ArrowRight" ? (index + 1) % trashGroups.length : event.key === "ArrowLeft" ? (index + trashGroups.length - 1) % trashGroups.length : event.key === "Home" ? 0 : event.key === "End" ? trashGroups.length - 1 : -1;
                if (next < 0) return;
                event.preventDefault(); setTrashTab(trashGroups[next].kind);
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}>{group.label}<small>{group.items.length}</small></button>)}
            </nav>
            {trashGroups.filter(group => group.kind === trashTab).map((group) => (
              <section className="trash-group" key={group.kind} role="tabpanel" id={"trash-panel-" + group.kind} aria-labelledby={"trash-tab-" + group.kind} tabIndex={0}>
                {group.items.length ? (
                  group.items.map((item) => (
                    <div className="trash-row" key={item.id}>
                      <Icon
                        name={
                          group.kind === "teams"
                            ? "users"
                            : group.kind === "spaces"
                              ? "book"
                              : "file"
                        }
                      />
                      <div>
                        <strong>{item.title || item.name}</strong>
                        <small>
                          {item.space_name || item.team_name || ""}
                          {item.archived ? translateUI(" · 已归档") : ""}
                        </small>
                      </div>
                      <time>
                        <span
                          title={
                            translateUI("自动清理时间：{0}", [new Date(item.expires_at).toLocaleString(uiLocale())])
                          }
                        >
                          {new Date(item.expires_at).getTime() > Date.now()
                            ? translateUI("还剩 {0} 天", [Math.ceil((new Date(item.expires_at).getTime() - Date.now()) / 86400000)])
                            : translateUI("等待自动清理")}
                        </span>
                      </time>
                      <button
                        disabled={busy || state.offline}
                        aria-label={
                          translateUI("恢复{0} {1}", [group.label, (item.title || item.name)])
                        }
                        onClick={() => void restoreItem(group.kind, item.id)}
                      >{translateUI("恢复 ")}</button>
                      <button
                        className="danger-action"
                        disabled={busy || state.offline}
                        aria-label={
                          translateUI("彻底删除{0} {1}", [group.label, (item.title || item.name)])
                        }
                        onClick={() => {
                          setPurgeName("");
                          setPurgeTarget({
                            id: item.id,
                            title: item.title || item.name,
                            kind: group.kind,
                            token: item.trash_batch,
                          });
                        }}
                      >{translateUI("彻底删除 ")}</button>
                    </div>
                  ))
                ) : (
                  <p className="trash-empty">{translateUI("没有已删除的")}{group.label}</p>
                )}
              </section>
            ))}
          </div>
        ) : page === "teams" || page === "team" ? (
          <TeamsHub
            key={`${teamId}:${teamHomeVisit}`}
            user={user}
            teamId={teamId}
            headerControls={compactNavigation}
            serverURL={state.serverURL}
            onSelect={openTeam}
            libraries={libraries}
            documents={notes}
            librariesContent={renderLibraries("team")}
            libraryViewControls={libraryViewControls()}
            initialTab={teamTab}
            onTabChange={setTeamTab}
            onNewLibrary={() => setDialog({kind:"library-new",libraryKind:"team",teamId,name:"",description:""})}
            onOpenLibrary={openLibrary}
            onOpenNote={(id) => {
              void request("documents/" + id + "?content=metadata")
                .then(openNote)
                .catch(report);
            }}
            onChanged={() => refresh()}
            onDeleteTeam={(team) => askDelete(team.id, team.name, "teams")}
            onError={report}
          />
        ) : (
          <div className="academic-browser">
            <header className={"academic-page-header" + (page === "personal" ? " library-collection-header" : "")}>
              <div className="compact-page-heading">{compactNavigation}<div>
                {page === "library" && <span className="page-eyebrow">{library?.kind === "personal" ? library.created_by !== user.id && library.creator_name ? translateUI("{0}的知识库", [library.creator_name]) : personalLibraryLabel : translateUI("{0}知识库", [teams.find(t => t.id === library?.team_id)?.name || translateUI("所属团队")])}</span>}
                <h1>
                  {page === "home"
                    ? scopeTeam?.name||translateUI("首页")
                    : page === "personal"
                      ? personalLibraryLabel
                      : page === "team"
                        ? selectedTeam
                          ? translateUI("{0}知识库", [selectedTeam.name])
                          : translateUI("请选择团队")
                        : library?.name || translateUI("知识库")}
                </h1>
                {page === "library" && library?.description && <p>{library.description}</p>}
                {page === "home" && scopeTeam?.description && <p className="muted">{scopeTeam.description}</p>}
              </div></div>
              <div className="workspace-header-actions"><div className="academic-page-actions">
                {page==="home"&&scopeTeam&&<WorkspaceLink href={hrefFor({page:"teams",teamId:scope})} className="home-team-link" onNavigate={()=>openTeam(scope)}><Icon name="users"/>{translateUI("团队主页")}</WorkspaceLink>}
                {page === "personal" && <div className="library-view-toolbar">{libraryViewControls()}</div>}
                {page === "library" && (
                  <>
                    {library && pinButton(library)}
                    {!state.personal && !library?.archived && library?.kind === "personal" && library.created_by === user.id && <button onClick={()=>setSharingLibrary(library.id)}><Icon name="share"/>{translateUI("分享知识库")}</button>}
                    <button
                      className={archived ? "active" : ""}
                      onClick={() => {
                        setArchived((v) => !v);
                        setFolder(null);
                      }}
                    >
                      <Icon name="archive" />
                      {archived ? translateUI("返回笔记") : translateUI("归档笔记")}
                    </button>
                    {canOrganize && (
                      <button onClick={() => newFolder()}>
                        <Icon name="folder" />{translateUI("新建目录 ")}</button>
                    )}
                  </>
                )}
            {page === "personal" || page === "team" ? (
                  <button
                    className="primary"
                    disabled={
                      state.offline ||
                      (page === "team" &&
                        (!selectedTeam ||
                          selectedTeam.archived ||
                          (selectedTeam.role !== "admin" &&
                            !selectedTeam.members_can_create_libraries)))
                    }
                    onClick={() =>
                      setDialog({
                        kind: "library-new",
                        libraryKind: page as "personal" | "team",
                        teamId: page === "team" ? teamId : undefined,
                        name: "",
                        description: "",
                      })
                    }
                  >
                    <Icon name="plus" />{translateUI("新建知识库 ")}</button>
                ) : (
                  <button
                    className="primary"
                    disabled={busy || loading || (page === "library" && !canCreateNotes) || (page === "home" && !canCreateInScope)}
                    onClick={() => void createNote()}
                  >
                    <Icon name="plus" />{translateUI("新建笔记 ")}</button>
                )}
              </div></div>
            </header>
                {page === "library"&&library?.archived&&<div className="library-archive-notice" role="status"><Icon name="archive"/><p>{translateUI("此知识库已归档，只能阅读、搜索和导出。")}</p>{library.role==="admin"&&!state.offline&&<button onClick={()=>setArchiveTarget(library)}>{translateUI("恢复知识库")}</button>}</div>}
            {page === "personal" || page === "team" ? (
              renderLibraries(page as "personal" | "team")
            ) : (
              <>
                <div className="academic-list-controls">
                  {page === "home" ? (
                    <nav className="home-tabs">
                      {[
                        ["recent", scope === "personal" ? translateUI("最近") : translateUI("团队首页")],
                        ["shared", translateUI("分享给我")],
                        ["outgoing", translateUI("我的分享")],
                      ]
                        .filter(
                          ([v]) =>
                            !state.personal || v === "recent",
                        )
                        .map(([v, l]) => (
                          <button
                            key={v}
                            className={homeTab === v ? "active" : ""}
                            onClick={() => setHomeTab(v)}
                          >
                            {l}
                          </button>
                        ))}
                    </nav>
                  ) : (
                    <div className="folder-breadcrumb">
                      <button
                        onClick={() => openFolder(null)}
                        onDragOver={(e) => {
                          if (
                            canCreateNotes &&
                            e.dataTransfer.types.includes(
                              "application/x-academic-note",
                            )
                          )
                            e.preventDefault();
                        }}
                        onDrop={(e) => drop(e, null)}
                      >{translateUI("全部笔记 ")}</button>
                      {folderPath.map((item) => (
                        <React.Fragment key={item.id}>
                          <Icon name="chevron" size={14} />
                          <button onClick={() => openFolder(item.id)}>
                            {item.name}
                          </button>
                        </React.Fragment>
                      ))}
                      {archived && <small>{translateUI("归档")}</small>}
                    </div>
                  )}
                  {!showingTeamHome&&<label className="academic-search">
                    <Icon name="search" size={17} />
                    <input
                      aria-label={translateUI("搜索笔记")}
                      placeholder={translateUI("搜索标题、正文或标签")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>}
                </div>
                {page === "home" && scope==="personal" && homeTab === "shared" && sharedPersonalLibraries.length>0 && <section className="shared-library-list" aria-label={translateUI("分享给我的知识库")}><h2>{translateUI("共享知识库")}</h2>{sharedPersonalLibraries.map(book=><button key={book.id} onClick={()=>openLibrary(book.id)}><Icon name="book"/><span>{book.name}<small>{book.creator_name}{translateUI(" · 只读")}</small></span></button>)}</section>}
                {showingTeamHome?<TeamHome key={`${state.serverURL}:${user.id}:${scope}:${state.offline}`} teamId={scope} cachedTeam={scopeTeam} offline={state.offline} libraries={libraries} documents={notes} onOpenNote={id=>{void request("documents/"+id+"?content=metadata").then(openNote).catch(report);}} onManage={()=>{openTeam(scope);setTeamTab("settings");}} onError={report}/>:page === "home" && homeTab === "outgoing" && !state.personal ? <MyShares key={scope} scope={scope} kind={scope==="personal"?shareKind:"notes"} onKindChange={setShareKind} status={shareStatus} onStatusChange={setShareStatus} query={query} offline={state.offline} serverURL={state.serverURL} onOpenLibrary={openLibrary} onOpenNote={id => {void request("documents/"+id).then(openNote).catch(report);}} onChanged={() => void refresh()}/> : loading ? (
                  <div className="academic-empty">{translateUI("正在加载笔记…")}</div>
                ) : (
                  page === "library" && !query.trim() && !archived ? <LibraryOutline key={libraryId} catalog={catalog} folders={folders} notes={visible} storageKey={`simple-notes:collapsed:${state.serverURL}:${user.id}:${libraryId}`} canOrganize={canOrganize} canCreate={canCreateNotes} showAuthors={showNoteAuthors} noteRow={noteRow} onFolder={item => setDialog({kind:"folder-edit",id:item.id,name:item.name,parent:item.parent_id || ""})} onMove={async (entry,parent,before) => {
                    try {setCatalog(await request(`spaces/${libraryId}/catalog`,"PATCH",{revision:catalog.revision,kind:entry.kind,id:entry.id,parent_id:parent,before}));await refresh();}
                    catch(error) {report(error);setCatalog(await request(`spaces/${libraryId}/catalog`));}
                  }} /> : renderNotes()
                )}
              </>
            )}
          </div>
        )}
      </main>
      {sharingLibrary&&<LibrarySharing id={sharingLibrary} serverURL={state.serverURL} onClose={()=>setSharingLibrary(null)} onChanged={()=>void refresh()}/>}
      {error && (
        <div className="academic-toast" role="alert">
          <span>{error}</span>
          <button aria-label={translateUI("关闭提示")} onClick={() => setError("")}>
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      {deleteTarget && (
        <div className="modal academic-modal">
          <section
            ref={deleteDialog}
            className="academic-dialog delete-dialog"
            role="dialog"
            aria-label={translateUI("确认删除")}
          >
            <header>
              <h2>{translateUI("删除 ")}{deleteTarget.kind === "teams"
                  ? translateUI("团队")
                  : deleteTarget.kind === "spaces"
                    ? translateUI("知识库")
                    : translateUI("笔记")}
              </h2>
              <DialogClose onClick={()=>setDeleteTarget(null)} disabled={busy}/>
            </header>
            <p>{translateUI("将“")}{deleteTarget.title}{translateUI("”移入回收站？")}</p>
            <p className="delete-explanation">
              {deleteTarget.kind === "documents"
                ? translateUI("正文、附件引用、评论和历史版本会保留，可从回收站恢复。")
                : translateUI("其下{0}笔记会一同隐藏，成员将无法访问。恢复时会保留原有目录及权限，之前单独删除的内容仍留在回收站。", [deleteTarget.kind === "teams" ? translateUI("知识库及") : ""])}{" "}{translateUI("已有外部分享链接 ")}{deleteTarget.kind === "teams" ? translateUI("和未接受的团队邀请") : ""}{translateUI("将撤销。 ")}</p>
            <footer>
              <button disabled={busy} onClick={() => setDeleteTarget(null)}>{translateUI("取消 ")}</button>
              <button
                className="danger-button"
                disabled={busy || state.offline}
                onClick={() => void deleteItem()}
              >
                {busy ? translateUI("正在删除…") : translateUI("移入回收站")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {purgeTarget && (
        <div className="modal academic-modal">
          <form
            ref={purgeDialog}
            className="academic-dialog delete-dialog"
            role="dialog"
            aria-label={translateUI("确认彻底删除")}
            onSubmit={purgeItem}
          >
            <header>
              <h2>{translateUI("彻底删除")}</h2>
              <DialogClose onClick={()=>setPurgeTarget(null)} disabled={busy}/>
            </header>
            <p>{translateUI("永久删除“")}{purgeTarget.title}”？
              {purgeTarget.kind !== "documents"
                ? translateUI("其中的目录、笔记也将一并彻底删除。")
                : ""}
            </p>
            <p className="delete-explanation">{translateUI("此操作无法撤销，正文、评论和历史版本将被移除；不再被使用的附件也会清理。仍被其他笔记引用的原文件会保留。 ")}</p>
            <label>{translateUI("输入名称确认 ")}<input
                aria-label={translateUI("输入名称确认彻底删除")}
                autoFocus
                value={purgeName}
                onChange={(e) => setPurgeName(e.target.value)}
                autoComplete="off"
              />
            </label>
            <footer>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPurgeTarget(null)}
              >{translateUI("取消 ")}</button>
              <button
                className="danger-button"
                disabled={
                  busy || state.offline || purgeName !== purgeTarget.title
                }
              >
                {busy ? translateUI("正在删除…") : translateUI("确认彻底删除")}
              </button>
            </footer>
          </form>
        </div>
      )}
      {archiveTarget&&<LibraryArchiveDialog library={archiveTarget} local={!!state.personal} onClose={()=>setArchiveTarget(null)} onChanged={async()=>{await refresh();window.dispatchEvent(new Event("anote-note-changed"));}} onError={report}/>}
      {dialog && (
        <div className="modal academic-modal">
          <form
            ref={editDialog}
            className={`academic-dialog${dialog.kind==="note-edit"?" note-settings-dialog":""}`}
            role="dialog"
            aria-label={
              dialog.kind === "library-new"
                ? translateUI("新建知识库")
                : dialog.kind === "library-edit"
                  ? translateUI("管理知识库")
                  : dialog.kind === "folder-new"
                    ? translateUI("新建目录")
                    : dialog.kind === "folder-edit"
                      ? translateUI("管理目录")
                      : translateUI("笔记设置")
            }
            onSubmit={saveDialog}
          >
            <header>
              <h2>
                {dialog.kind === "library-new"
                  ? translateUI("新建{0}知识库", [(dialog.libraryKind === "personal" ? translateUI("个人") : translateUI("团队"))])
                  : dialog.kind === "library-edit"
                    ? translateUI("管理知识库")
                    : dialog.kind === "folder-new"
                      ? translateUI("新建目录")
                      : dialog.kind === "folder-edit"
                        ? translateUI("管理目录")
                        : translateUI("笔记设置")}
              </h2>
              <DialogClose onClick={()=>setDialog(null)} disabled={busy}/>
            </header>
            <label>
              {dialog.kind.startsWith("library")
                ? translateUI("知识库名称")
                : dialog.kind.startsWith("folder")
                  ? translateUI("目录名称")
                  : translateUI("笔记名称")}
              <input
                autoFocus
                required
                aria-label={translateUI("名称")}
                maxLength={dialog.kind.startsWith("note") ? 200 : 100}
                value={dialog.name}
                disabled={busy||!!dialog.movePreview||(dialog.kind==="library-edit"&&!!libraries.find(book=>book.id===dialog.id)?.archived)}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            {dialog.kind.startsWith("library") && (
              <label>{translateUI("简介 ")}<textarea
                  aria-label={translateUI("简介")}
                  rows={3}
                  disabled={busy||(dialog.kind==="library-edit"&&!!libraries.find(book=>book.id===dialog.id)?.archived)}
                  value={dialog.description || ""}
                  onChange={(e) =>
                    setDialog({ ...dialog, description: e.target.value })
                  }
                />
              </label>
            )}
            {dialog.kind === "library-new" && dialog.libraryKind === "team" && (
              <label>{translateUI("所属团队 ")}<select
                  aria-label={translateUI("所属团队")}
                  required
                  value={dialog.teamId || teams[0]?.id || ""}
                  onChange={(e) =>
                    setDialog({ ...dialog, teamId: e.target.value })
                  }
                >
                  {teams
                    .filter((t) => !t.archived)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {(dialog.libraryKind === "team" ||
              (dialog.kind === "library-edit" &&
                libraries.find((l) => l.id === dialog.id)?.kind ===
                  "team")) && (
              <label>{translateUI("可见范围 ")}<select
                  aria-label={translateUI("知识库可见范围")}
                  value={dialog.accessMode || library?.access_mode || "team"}
                  onChange={(e) =>
                    setDialog({ ...dialog, accessMode: e.target.value })
                  }
                >
                  <option value="team">{translateUI("团队成员可访问")}</option>
                  <option value="restricted">{translateUI("仅指定成员与团队管理员")}</option>
                </select>
              </label>
            )}
            {dialog.kind === "library-edit" && dialog.libraryKind === "team" && teams.find(t => t.id === dialog.teamId)?.role === "admin" && <label className="management-check"><input type="checkbox" aria-label={translateUI("团队置顶知识库")} checked={!!dialog.pinned} onChange={e => setDialog({...dialog,pinned:e.target.checked})} />{translateUI("团队置顶知识库")}</label>}
            {dialog.kind === "library-edit" && dialog.libraryKind === "personal" && <p className="muted">{translateUI("个人知识库仅自己可见，单篇笔记可在编辑页共享。")}</p>}
            {dialog.kind.startsWith("folder") && (
              <label>
                {dialog.kind.startsWith("folder") ? translateUI("父目录") : translateUI("所在目录")}
                <select
                  aria-label={translateUI("所在目录")}
                  value={dialog.parent || ""}
                  onChange={(e) =>
                    setDialog({ ...dialog, parent: e.target.value })
                  }
                >
                  <option value="">{translateUI("知识库根目录")}</option>
                  {folders
                    .filter(
                      (f) =>
                        dialog.kind !== "folder-edit" ||
                        !branchIds(dialog.id!).has(f.id),
                    )
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {dialog.kind==="note-edit"&&notes.find(n=>n.id===dialog.id)?.role==="admin"&&(()=>{const source=libraries.find(l=>l.id===notes.find(n=>n.id===dialog.id)?.space_id);return source?<NoteLocationPicker source={source} libraries={state.personal?[source]:libraries} libraryId={dialog.targetLibraryId||source.id} folderId={dialog.parent||""} disabled={busy||!!dialog.movePreview||!!state.offline} onChange={(targetLibraryId,parent)=>setDialog({...dialog,targetLibraryId,parent,movePreview:undefined})}/>:null;})()}
            {dialog.kind === "note-edit" && (
              <label>{translateUI("标签 ")}<input
                  aria-label={translateUI("笔记标签")}
                  placeholder={translateUI("用逗号分隔")}
                  value={dialog.tags || ""}
                  disabled={busy||!!dialog.movePreview}
                  onChange={(e) =>
                    setDialog({ ...dialog, tags: e.target.value })
                  }
                />
              </label>
            )}
            {dialog.movePreview&&<section className="note-move-confirm" aria-label={translateUI("确认移动")}><strong>{translateUI("移至 ")}{dialog.movePreview.destination.name}</strong><p>{translateUI("可见范围：")}{dialog.movePreview.visibility==="team"?translateUI("目标知识库可访问成员"):translateUI("仅作者与目标库管理员")}</p><p>{dialog.movePreview.notice}</p><small>{translateUI("保留 ")}{dialog.movePreview.attachments}{translateUI(" 个附件 · 撤销 ")}{dialog.movePreview.collaborators_to_remove}{translateUI(" 项成员授权、")}{dialog.movePreview.external_links_to_revoke}{translateUI(" 个外链")}</small></section>}
            <footer>
              {dialog.movePreview&&<button type="button" disabled={busy} onClick={()=>setDialog({...dialog,movePreview:undefined})}>{translateUI("返回修改")}</button>}
              {dialog.kind === "note-edit" &&
                !dialog.movePreview&&
                notes.find((n) => n.id === dialog.id)?.role === "admin" && (
                  <button
                    type="button"
                    className="danger-action"
                    disabled={busy || state.offline}
                    onClick={() => askDelete(dialog.id!, dialog.name)}
                  >{translateUI("删除笔记 ")}</button>
                )}
              {dialog.kind === "library-edit" && libraries.find(book=>book.id===dialog.id)?.role==="admin" && <button type="button" disabled={busy||state.offline} onClick={()=>{setArchiveTarget(libraries.find(book=>book.id===dialog.id)!);setDialog(null);}}>{libraries.find(book=>book.id===dialog.id)?.archived?translateUI("恢复知识库"):translateUI("归档知识库")}</button>}
              {dialog.kind === "library-edit" &&
                libraries.find((l) => l.id === dialog.id)?.role === "admin" && (
                  <button
                    type="button"
                    className="danger-action"
                    disabled={busy || state.offline||!!libraries.find(book=>book.id===dialog.id)?.archived}
                    onClick={() => askDelete(dialog.id!, dialog.name, "spaces")}
                  >{translateUI("删除知识库 ")}</button>
                )}
              {dialog.kind === "library-edit" && dialog.libraryKind === "team" && <button type="button" disabled={!!libraries.find(book=>book.id===dialog.id)?.archived} onClick={() => { setPermissionLibraryId(dialog.id!); setDialog(null); }}>{translateUI("权限分配")}</button>}
              {dialog.kind === "folder-edit" && (
                <button type="button" className="danger-action" disabled={busy || state.offline} onClick={() => { setFolderDeleteTarget(folders.find(f=>f.id===dialog.id)!);setDialog(null); }}>{translateUI("删除目录")}</button>
              )}
              {dialog.kind === "folder-edit" && (
                <button type="button" onClick={() => newFolder(dialog.id!)}>{translateUI("新建子目录 ")}</button>
              )}
              {dialog.kind === "note-edit" && !dialog.movePreview&&notes.find(n => n.id === dialog.id)?.role === "admin" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const note = notes.find((n) => n.id === dialog.id);
                      await request(`documents/${dialog.id}`, "PATCH", {
                        archived: !note?.archived,
                      });
                      setDialog(null);
                      if (selected === dialog.id) {
                        setSelected(null);
                        address(null, libraryId);
                      }
                      await refresh();
                    } catch (e) {
                      report(e);
                    }
                  }}
                >
                  {notes.find((n) => n.id === dialog.id)?.archived
                    ? translateUI("取消归档")
                    : translateUI("归档笔记")}
                </button>
              )}
              <span />
              <button type="button" disabled={busy} onClick={() => setDialog(null)}>{translateUI("取消 ")}</button>
              <button className="primary" disabled={busy||(dialog.kind==="library-edit"&&!!libraries.find(book=>book.id===dialog.id)?.archived)}>
                {busy ? translateUI("保存中…") : dialog.movePreview?translateUI("确认移动"):translateUI("保存")}
              </button>
            </footer>
          </form>
        </div>
      )}
      <TeamInvitation
        onJoined={(id) => {
          void refresh();
          navigate("teams");
          setTeamId(id);
        }}
        onError={report}
      />
      {folderDeleteTarget && <div className="modal academic-modal"><form ref={folderDeleteDialog} className="academic-dialog" role="dialog" aria-label={translateUI("删除目录")} onSubmit={async event=>{
        event.preventDefault();if(busy)return;setBusy(true);
        try{await request(`spaces/${libraryId}/folders/${folderDeleteTarget.id}`,"DELETE");setFolderDeleteTarget(null);setFolder(null);await refresh();}
        catch(error){report(error);}finally{setBusy(false);}
      }}><header><h2>{translateUI("删除目录")}</h2><DialogClose onClick={()=>setFolderDeleteTarget(null)} disabled={busy}/></header><p>{translateUI("删除“")}{folderDeleteTarget.name}{translateUI("”后，下级笔记和子目录将移到“")}{folders.find(f=>f.id===folderDeleteTarget.parent_id)?.name || translateUI("知识库根目录")}{translateUI("”，内容会保留。")}</p><footer><button type="button" disabled={busy} onClick={()=>setFolderDeleteTarget(null)}>{translateUI("取消")}</button><button className="danger-action" disabled={busy}>{busy?translateUI("正在删除…"):translateUI("确认删除目录")}</button></footer></form></div>}
      {permissionLibraryId && libraries.find(l => l.id === permissionLibraryId && l.kind === "team" && l.role === "admin") && <LibraryPermissionsDialog user={user} space={libraries.find(l => l.id === permissionLibraryId)!} onClose={() => setPermissionLibraryId("")} onError={report} />}
      {settings && (
        <div className="modal academic-modal">
          <section
            ref={settingsDialog}
            className="academic-settings workspace-settings"
            role="dialog"
            aria-label={translateUI("设置")}
            aria-modal="true"
          >
            <header>
              <h2>{translateUI("设置")}</h2>
              <DialogClose onClick={()=>setSettings("")}/>
            </header>
            <nav>
              <button
                className={settings === "general" ? "active" : ""}
                onClick={() => setSettings("general")}
              >{translateUI("账号与偏好 ")}</button>
              <button className={settings === "ai" ? "active" : ""} onClick={() => setSettings("ai")}>{translateUI("AI工具链")}</button>
              {state.desktop===true && <button className={settings === "offline" ? "active" : ""} onClick={()=>setSettings("offline")}>{translateUI("离线与备份")}</button>}
              {user.is_admin && (
                <button
                  className={settings === "team" ? "active" : ""}
                  onClick={() => setSettings("team")}
                >{translateUI("平台管理 ")}</button>
              )}

              {(!state.personal || native) && (
                <button
                  className={settings === "clients" ? "active" : ""}
                  onClick={() => setSettings("clients")}
                >
                  {native?translateUI("客户端更新"):translateUI("桌面客户端")}
                </button>
              )}
            </nav>
            <div className="settings-body">
              {settings === "team" && user.is_admin ? (
                <PlatformAdmin user={user} onError={report} />

              ) : settings === "offline" && state.desktop===true ? (
                <OfflineControls state={state} onError={report}/>
              ) : settings === "clients" ? (
                <Clients onError={report} onConnectServer={connectForUpdate} updateState={state.updates} authenticated={!(native&&(state.personal||!state.token))} serverURL={state.personal?state.connectionServerURL:state.serverURL}/>
              ) : settings === "ai" ? (
                state.personal?<LocalMcpSettings onError={report}/>:state.offline ? <p className="muted">{translateUI("连接服务器后可管理 AI 工具链。")}</p> : <McpConnections onError={report}/>
              ) : (
                <>
                  <LanguageSelect />
                  <div className="profile-card">
                    <span className="user-avatar">{user.name.slice(0, 1)}</span>
                    <div>
                      <h3>{user.name}</h3>
                      <p>{user.username || ""}</p>
                    </div>
                    {(!native || state.personal) && <span className="profile-status">
                      {state.personal
                        ? translateUI("本地个人模式")
                        : state.offline
                          ? translateUI("离线")
                          : translateUI("在线")}
                    </span>}
                  </div>
                  <p>
                    {state.personal
                      ? translateUI("个人模式仅保存到当前设备。连接服务器可访问平台上的个人与团队笔记，本地个人笔记会继续保留在当前目录。")
                      : translateUI("个人笔记默认仅自己可见；团队笔记继承知识库权限，团队外链由团队安全设置控制。")}
                  </p>
                  {native && (
                    <>
                      {!state.personal && (
                        <p className="muted">{translateUI("服务器：")}{siteName} · {state.serverURL}</p>
                      )}
                      {state.credentialWarning && (
                        <p className="muted">{state.credentialWarning}</p>
                      )}
                      <button
                        onClick={() => {
                          setSettings("");
                          onReconnect?.();
                        }}
                      >
                        {connectionLabel}
                      </button>
                      <section className="settings-save-mode">
                        <h3>{translateUI("保存方式")}</h3>
                        <ClientStorage state={state}/>
                        {state.personal ? <>
                          <button onClick={()=>void window.anote.openPersonalFolder().catch(report)}>{translateUI("打开本地笔记目录")}</button>
                          <button onClick={()=>void window.anote.enterPersonal().catch(report)}>{translateUI("打开其他个人目录")}</button>
                        </> : <>
                          <p className="muted">{translateUI("服务器笔记保存到平台。可在“离线与备份”中开启常驻本地副本，也可另开独立的个人笔记目录。")}</p>
                          <button onClick={()=>void window.anote.enterPersonal().catch(report)}>{translateUI("本地个人笔记")}</button>
                        </>}
                      </section>
                    </>
                  )}
                  <NicknameSettings
                    user={user}
                    disabled={!!state.offline || !!state.validationMode}
                    onSaved={setProfile}
                  />
                  {!state.personal && (
                    <ProfileSettings
                      user={user}
                      onError={report}
                      onLogout={onLogout}
                    />
                  )}
                  {!state.personal && (
                    <AccountIdentity
                      native={native}
                      serverURL={state.serverURL}
                      onError={report}
                    />
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
