const { contextBridge, ipcRenderer } = require("electron");
const beforeClose = new Set();
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
  onBeforeClose: (callback) => {
    beforeClose.add(callback);
    return () => beforeClose.delete(callback);
  },
  state: () => ipcRenderer.invoke("anote:state"),
  enterPersonal: () => ipcRenderer.invoke("anote:personal-enter"),
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
