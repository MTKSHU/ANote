const { contextBridge, ipcRenderer } = require("electron");
const beforeClose = new Set();
ipcRenderer.on('anote:personal-document-changed',(_event,detail)=>{
  window.dispatchEvent(new CustomEvent('anote-local-document-changed',{detail}));
  window.dispatchEvent(new Event('anote-note-changed'));
});
// Chromium does not reliably open modified anchors inside contenteditable.
// Keep native note links on the existing window-open policy in main: server
// notes map to that server, while personal note IDs never leave the client.
const modifiedNote = (event) => {
  if (window.location.protocol !== "anote:" || window.location.hostname !== "app" || event.defaultPrevented) return;
  const primary = event.type === "click" && event.button === 0 && (event.ctrlKey || event.metaKey) && !event.altKey;
  const middle = event.type === "auxclick" && event.button === 1;
  if (!primary && !middle) return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const href = link?.getAttribute("href") || "";
  if (!/^\/\?doc=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(href)) return;
  event.preventDefault();
  window.open(new URL(href, window.location.href).href, "_blank", "noopener,noreferrer");
};
document.addEventListener("click", modifiedNote, true);
document.addEventListener("auxclick", modifiedNote, true);
window.addEventListener("online", () => {
  void ipcRenderer.invoke("anote:update-online").catch(() => {});
});
ipcRenderer.on("anote:before-close", async (_event, nonce) => {
  try {
    await Promise.all([...beforeClose].map((callback) => callback()));
    ipcRenderer.send("anote:close-ready", { nonce, ok: true });
  } catch (error) {
    ipcRenderer.send("anote:close-ready", {
      nonce,
      ok: false,
      error: error.message,
    });
  }
});
contextBridge.exposeInMainWorld("anote", {
  setLocale: (locale) => ipcRenderer.invoke("anote:locale", locale),
  localMcpState:()=>ipcRenderer.invoke('anote:local-mcp-state'),
  configureLocalMcp:input=>ipcRenderer.invoke('anote:local-mcp-configure',input),
  exportNoteMarkdown:input=>ipcRenderer.invoke('anote:note-export-markdown',input),
  onNoteExportProgress:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('anote:note-export-progress',listener);return()=>ipcRenderer.removeListener('anote:note-export-progress',listener);},
  onBeforeClose: (callback) => {
    beforeClose.add(callback);
    return () => beforeClose.delete(callback);
  },
  state: () => ipcRenderer.invoke("anote:state"),
  storageDirectory: () => ipcRenderer.invoke("anote:storage-directory"),
  retryStorageDirectory: () => ipcRenderer.invoke("anote:storage-retry"),
  migrateStorageDirectory: () => ipcRenderer.invoke("anote:storage-migrate"),
  rendererReady: () => ipcRenderer.invoke("anote:renderer-ready"),
  updateState: () => ipcRenderer.invoke("anote:update-state"),
  checkUpdates: () => ipcRenderer.invoke("anote:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("anote:update-download"),
  installUpdate: () => ipcRenderer.invoke("anote:update-install"),
  openUpdateFolder: () => ipcRenderer.invoke("anote:update-open"),
  offlineStatus: () => ipcRenderer.invoke("anote:offline-status"),
  configureOffline: (config) => ipcRenderer.invoke("anote:offline-configure",config),
  downloadOffline: () => ipcRenderer.invoke("anote:offline-download"),
  syncOffline: () => ipcRenderer.invoke("anote:offline-sync"),
  cacheOfflineDocument: (input) => ipcRenderer.invoke("anote:offline-cache-document",input),
  chooseBackupDirectory: () => ipcRenderer.invoke("anote:backup-directory"),
  createBackup: () => ipcRenderer.invoke("anote:backup-create"),
  listBackups: () => ipcRenderer.invoke("anote:backup-list"),
  deleteBackup: (id) => ipcRenderer.invoke("anote:backup-delete",id),
  restoreBackup: (id) => ipcRenderer.invoke("anote:backup-restore",id),
  openBackupFolder: () => ipcRenderer.invoke("anote:backup-open"),
  resolveOfflineConflict: (id,choice) => ipcRenderer.invoke("anote:offline-resolve",id,choice),
  exportNotePDF: (input) => ipcRenderer.invoke("anote:note-export-pdf", input),
  enterPersonal: () => ipcRenderer.invoke("anote:personal-enter"),
  openLocalWorkspace: () => ipcRenderer.invoke("anote:workspace-local"),
  serverWorkspaces: () => ipcRenderer.invoke("anote:workspace-context"),
  openServerWorkspace: (input) => ipcRenderer.invoke("anote:workspace-server",input),
  leavePersonal: () => ipcRenderer.invoke("anote:personal-leave"),
  openPersonalFolder: () => ipcRenderer.invoke("anote:personal-folder"),
  connect: (input) => ipcRenderer.invoke("anote:connect", input),
  casdoorProviders: (serverURL) =>
    ipcRenderer.invoke("anote:casdoor-providers", serverURL),
  connectCasdoor: (input) =>
    ipcRenderer.invoke("anote:connect-casdoor", input),
  cancelCasdoor: () => ipcRenderer.invoke("anote:cancel-casdoor"),
  logout: () => ipcRenderer.invoke("anote:logout"),
  offline: (value) => ipcRenderer.invoke("anote:offline", value),
  chooseWorkspace: () => ipcRenderer.invoke("anote:workspace"),
  checkout: (input) => ipcRenderer.invoke("anote:checkout", input),
  sync: (id) => ipcRenderer.invoke("anote:sync", id),
  acceptRemote: (id) => ipcRenderer.invoke("anote:accept-remote", id),
  selectDocument: (id, scope) => ipcRenderer.invoke("anote:select-document", id, scope),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("anote:state-changed", listener);
    return () => ipcRenderer.removeListener("anote:state-changed", listener);
  },
});
