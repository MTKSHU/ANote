export type WorkspaceLocation = {
  scope?: string;
  page: string;
  teamId: string;
  teamTab: string;
  libraryId: string;
  selected: string | null;
  folder: string | null;
  homeTab: string;
  archived: boolean;
  query: string;
  trashTab: "teams" | "spaces" | "documents";
  shareKind: string;
  shareStatus: string;
};

const homeTabs = ["recent", "shared", "outgoing"];
const teamTabs = ["home", "libraries", "members", "settings"];

export function readWorkspaceLocation(search: string, lastDoc: string | null = null, personal = false): WorkspaceLocation {
  const params = new URLSearchParams(search);
  const explicit = ["doc", "space", "team", "page", "tab", "scope", "q"].some(key => params.has(key));
  const selected = params.get("doc") || (!explicit ? lastDoc : null);
  const libraryId = params.get("space") || "", teamId = params.get("team") || "";
  const requested = params.get("page") || "home";
  const page = selected || libraryId ? "library" : teamId ? "teams"
    : ["home", "personal", "teams", "trash", "wishes", "notifications",...(!personal?["friends"]:[])].includes(requested) ? requested : "home";
  const homeTab = params.get("tab") || "recent";
  const teamTab = params.get("view") || "home";
  return {
    scope:personal?"":(params.get("scope")||""),
    page, selected, libraryId, teamId,
    homeTab: homeTabs.includes(homeTab) && (!personal || homeTab === "recent") ? homeTab : "recent",
    teamTab: teamTabs.includes(teamTab) ? teamTab : "home",
    folder: params.get("folder") || null,
    archived: params.get("archived") === "1",
    query: (params.get("q") || "").slice(0, 200),
    trashTab: params.get("type") === "teams" ? "teams" : params.get("type") === "spaces" ? "spaces" : "documents",
    shareKind: params.get("sharing") === "libraries" ? "libraries" : "notes",
    shareStatus: ["all","inactive"].includes(params.get("status") || "") ? params.get("status")! : "active",
  };
}

export function workspaceAddress(route: WorkspaceLocation) {
  const params = new URLSearchParams();
  if(route.scope)params.set("scope",route.scope);
  if (route.selected) params.set("doc", route.selected);
  else if (route.page === "library" && route.libraryId) {
    params.set("space", route.libraryId);
    if (route.folder) params.set("folder", route.folder);
    if (route.archived) params.set("archived", "1");
  } else if (["teams", "team"].includes(route.page) && route.teamId) {
    params.set("team", route.teamId);
    if (route.teamTab !== "home") params.set("view", route.teamTab);
  } else if (route.page === "home") {
    if (homeTabs.includes(route.homeTab) && route.homeTab !== "recent") params.set("tab", route.homeTab);
    if (route.homeTab === "outgoing") {
      if (route.shareKind === "libraries") params.set("sharing", "libraries");
      if (route.shareStatus !== "active") params.set("status", route.shareStatus);
    }
  } else {
    params.set("page", route.page);
    if (route.page === "trash" && route.trashTab !== "documents") params.set("type", route.trashTab);
  }
  if (!route.selected && ["home", "library"].includes(route.page) && route.query) params.set("q", route.query);
  return "/" + (params.size ? "?" + params : "");
}
