import { setLocale, t } from "@anote/i18n";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  safeStorage,
  shell,
  nativeTheme,
  Menu,
} from "electron";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { localAsset } from "./local-assets.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SessionStore, atomicJSON, readJSON } from "./session-store.mjs";
import { CasdoorLogin } from "./casdoor-login.mjs";
import { SyncService } from "./sync-service.mjs";
import { PersonalStore } from "./personal-store.mjs";
import { clientDataRoot } from "./client-data.mjs";
import {exportNotePDF,exportNoteMarkdown} from "./note-export.mjs";
import {LocalMcp} from './local-mcp.mjs';
import {OfflineStore} from "./offline-store.mjs";
import {DesktopUpdater} from "./updater.mjs";
import {UpdateChecks} from "./update-checks.mjs";
import {migrateStorageTree,assertStorageDirectory,assertPersonalDirectory} from "./storage-migration.mjs";
import {WorkspaceContexts} from "./workspace-context.mjs";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "anote",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app.setName("ANote");
if (process.env.ANOTE_LOCALE) {
  setLocale(process.env.ANOTE_LOCALE);
  app.commandLine.appendSwitch("lang", process.env.ANOTE_LOCALE);
}
app.setPath("userData",clientDataRoot(app.getPath("appData"),app.getPath("userData"),process.env.ANOTE_CLIENT_DATA_DIR,{preview:typeof ANOTE_BUILD_CHANNEL==="string"&&ANOTE_BUILD_CHANNEL==="preview"}));
const requestedDoc = process.argv
  .find((v) => v.startsWith("--document="))
  ?.slice(11);
let window, session, sync, personal, offlineStore, updater, updateChecks,localMcp;
let storageMigration = null, storageMigrating = false, storageFrozen = false, selectingStorage = false;
let storageError = "", unavailablePersonalDirectory = "";
const workspaceContexts=new WorkspaceContexts();
let switchingWorkspace=false,backupRestoring=false,backupBusy=false;
const defaultServerURL = typeof ANOTE_DEFAULT_SERVER_URL === "string" ? ANOTE_DEFAULT_SERVER_URL : "";
const sso = new CasdoorLogin((url) => shell.openExternal(url));
let stateRevision = 0;
const snapshot = () => ({
  desktop: true,
  stateRevision,
  storageMigrating,
  workspaceSwitching:switchingWorkspace,
  backupRestoring,
  backupBusy,
  storageError,
  ...(personal ? personal.state() : session.state()),
  ...(!personal&&unavailablePersonalDirectory?{user:null,offline:true,lastDoc:null}:{}),
  ...(!personal&&offlineStore?{offline:session.settings.offline||offlineStore.status().automaticOffline,offlineStorage:offlineStore.status()}:{}),
  updates:updater?.snapshot(),
  connectionServerURL:session?.settings.serverURL||"",
  connectionWorkspace:session?workspaceContexts.get(session):undefined,
  sync: personal
    ? { pending: [], documents: [] }
    : sync?.status() || { pending: [], documents: [] },
  testing: process.env.ANOTE_DESKTOP_TEST === "1",
});
const notify = () => {
  void localMcp?.sync();
  stateRevision++;
  if (window && !window.isDestroyed())
    window.webContents.send("anote:state-changed", snapshot());
};
function allowed(event) {
  if (
    event.sender !== window.webContents ||
    !event.senderFrame?.url.startsWith("anote://app/")
  )
    throw new Error("不受信任的客户端请求");
}
const handle = (name, fn) =>
  ipcMain.handle("anote:" + name, async (event, ...args) => {
    allowed(event);
    if((switchingWorkspace||storageMigrating||backupRestoring||backupBusy)&&["personal-enter","personal-leave","workspace-local","workspace-server","connect","connect-casdoor","logout","storage-migrate","update-install","backup-create","backup-restore","backup-delete"].includes(name))
      throw new Error("正在切换或保存工作空间，请稍后");
    if((backupRestoring||backupBusy)&&["offline-configure","offline-download","offline-sync","offline-resolve","backup-directory"].includes(name))
      throw new Error("正在处理本地备份，请等待完成");
    if(["preparing","installing"].includes(updater?.snapshot().status)&&["backup-create","backup-restore","backup-delete","backup-directory"].includes(name))
      throw new Error("正在安装客户端更新，请等待完成");
    if (storageFrozen && !["state", "renderer-ready", "offline-status", "update-state", "storage-directory"].includes(name))
      throw new Error("正在迁移工作目录，请等待完成");
    if (storageError && ["offline-configure","offline-download","offline-sync","offline-cache-document","backup-create","backup-restore","backup-delete","offline-resolve","workspace","checkout","sync","accept-remote"].includes(name))
      throw new Error(storageError);
    return fn(...args);
  });

async function flushRenderer() {
  if (!window || window.isDestroyed()) return;
  const nonce = randomUUID();
  await new Promise((resolve, reject) => {
    const listener = (event, result) => {
      try {
        allowed(event);
      } catch {
        return;
      }
      if (result?.nonce !== nonce) return;
      clearTimeout(timer);
      ipcMain.removeListener("anote:close-ready", listener);
      result.ok ? resolve() : reject(new Error(result.error || "本地保存失败"));
    };
    const timer = setTimeout(() => {
      ipcMain.removeListener("anote:close-ready", listener);
      reject(new Error("本地保存确认超时"));
    }, 15000);
    ipcMain.on("anote:close-ready", listener);
    window.webContents.send("anote:before-close", nonce);
  });
}

async function loadOfflineStore(){
  await offlineStore?.close();
  offlineStore=undefined;
  if(!personal&&session.settings.user&&session.settings.serverURL)
    offlineStore=await new OfflineStore(session,notify,{backupWorker:path.join(app.getAppPath(),"dist/backup-worker.cjs"),documentWorker:path.join(app.getAppPath(),"dist/document-worker.cjs")}).load();
}
async function loadServerStores() {
  await offlineStore?.close().catch(()=>{}); await sync?.close().catch(()=>{});
  offlineStore=undefined; sync=undefined;
  if (unavailablePersonalDirectory) return;
  storageError="";
  if (personal) return;
  try { await assertStorageDirectory(session); }
  catch (error) { storageError=error.message; return; }
  sync=await new SyncService(session,notify).load();
  await loadOfflineStore();
  await workspaceContexts.refresh(session);
}
async function closeConnection(){await flushRenderer();await offlineStore?.close();await sync?.close();}
const updateConnection = () => ({ serverURL:session.settings.serverURL || defaultServerURL, token:session.token });
const checkClientUpdates = options => updateChecks.run(options);
async function openExistingPersonal(directory){await assertPersonalDirectory(directory);return new PersonalStore(directory).load();}

async function start() {
  await app.whenReady();
  session = await new SessionStore(app.getPath("userData"), safeStorage).load();
  // Server availability is automatic. Retire the old persisted manual toggle
  // when a credential is available; no-token profiles still open cached notes.
  if(session.token&&session.settings.offline){session.settings.offline=false;await session.save();}
  const modeFile = path.join(app.getPath("userData"), "personal-mode.json"),
    savedMode = await readJSON(modeFile, {});
  async function savePersonalMode(directory,lastDirectory){
    const previous=await readJSON(modeFile,{});
    await atomicJSON(modeFile,{...(directory?{directory}:{}),...((directory||lastDirectory||previous.directory||previous.lastDirectory)?{lastDirectory:directory||lastDirectory||previous.directory||previous.lastDirectory}:{})});
  }
  if (savedMode.directory) {
    try {
      await assertPersonalDirectory(savedMode.directory);
      personal = await new PersonalStore(savedMode.directory).load();
    } catch (error) {
      unavailablePersonalDirectory=savedMode.directory;
      storageError=error.message;
      session.credentialWarning = error.message;
    }
  }
  await loadServerStores();
  await workspaceContexts.refresh(session);
  localMcp=new LocalMcp({getStore:()=>!switchingWorkspace&&!storageFrozen&&!storageMigrating&&!backupBusy&&!backupRestoring?personal:null,workerFile:path.join(app.getAppPath(),'dist','local-mcp-worker.cjs'),beforeAccess:name=>['read_note','list_notes','prepare_changes','apply_changes'].includes(name)?flushRenderer():Promise.resolve(),onState:notify,onChanged:detail=>{if(window&&!window.isDestroyed())window.webContents.send('anote:personal-document-changed',detail);}});
  await localMcp.sync();
  updater=new DesktopUpdater({directory:path.join(app.getPath("userData"),"updates"),currentVersion:app.getVersion(),platform:process.platform,arch:process.arch,execPath:process.execPath,isPackaged:app.isPackaged,onChange:notify,allowHTTP:process.env.ANOTE_DESKTOP_TEST==="1"});
  updateChecks = new UpdateChecks({check:()=>updater.check(updateConnection()),snapshot:()=>updater.snapshot(),contextKey:()=>JSON.stringify(updateConnection())});
  const webRoot = path.join(app.getAppPath(), "dist", "web"),
    cacheRoot = path.join(session.root, "http-cache");
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  async function proxy(request, url,options={}) {
    if (storageFrozen) return Response.json({error:"正在迁移工作目录，请等待完成"},{status:503});
    if (storageError && /^\/api\/(?:documents|spaces|assets|teams|trash)(?:\/|$)/.test(url.pathname))
      return Response.json({error:storageError},{status:503,headers:{"Cache-Control":"no-store"}});
    if (personal) {
      const response = await personal.respond(request, url);
      if (response.ok && request.method === "PATCH" && url.pathname === "/api/me/profile") notify();
      return response;
    }
    const store=offlineStore,connection={settings:structuredClone(session.settings)},token=session.token;
    const active=()=>!personal&&store===offlineStore&&connection.settings.serverURL===session.settings.serverURL&&connection.settings.user?.id===session.settings.user?.id;
    const switched=()=>Response.json({error:"账号或服务器已切换，请重试当前操作"},{status:409});
    const allowLegacyDocument=id=>store?.allowLegacyDocument?.(id)!==false;
    const fallbackRequest=/^\/api\/documents(?:\/[\w-]+)?$/.test(url.pathname)&&["POST","PATCH"].includes(request.method)?request.clone():request;
    const local=async()=>{if(!active())return switched();const result=await store?.read(fallbackRequest,url).catch(error=>Response.json({error:error.message},{status:503}));return active()?result:switched();};
    const note=url.pathname.match(/^\/api\/documents\/([\w-]+)(?:\/(?:info|preview))?$/),previewRead=!!note&&url.pathname.endsWith('/preview');
    const freshAccess=request.method==="GET"&&(previewRead||url.searchParams.get("content")==="metadata"&&url.searchParams.get("access_check")==="1");
    const denied=await store?.deniedResponse?.(request,url);if(!active())return switched();if(denied)return denied;
    const pendingLocalRead=request.method==="GET"&&note&&(!freshAccess||store?.isNewDocument(note[1]))&&(store?.hasPending(note[1])||store?.status().conflicts.some(item=>item.id===note[1]));
    if(store&&(connection.settings.offline||store.status().automaticOffline||pendingLocalRead)){
      const response=await local();if(response)return response;
    }
    const replicaRoute=/^\/api\/(?:documents|spaces|assets|teams)(?:\/|$)/.test(url.pathname);
    const observeJSON=request.method==="GET"&&(/^\/api\/(?:documents|spaces|teams)(?:\/|$)/.test(url.pathname)||url.pathname==="/api/platform/public");
    const cacheable =
      request.method === "GET" &&
      !replicaRoute &&
      !url.pathname.startsWith("/api/auth/") &&
      !url.pathname.startsWith("/api/assets/") &&
      !request.headers.has("range");
    const key = createHash("sha256")
        .update(
          connection.settings.serverURL +
            "|" +
            connection.settings.user?.id +
            "|" +
            url.pathname +
            url.search,
        )
        .digest("hex"),
      file = path.join(cacheRoot, key + ".json");
    if (!connection.settings.serverURL)
      return Response.json({ error: "请先连接研究空间" }, { status: 503 });
    try {
      if (connection.settings.offline||store?.status().automaticOffline) {
        const local = await localAsset(request, url, connection,allowLegacyDocument);
        if (local) return local;
      }
      if (connection.settings.offline||store?.status().automaticOffline) throw new Error("客户端处于离线模式");
      const headers = new Headers();
      headers.set('X-ANote-State-Encoding','2');
      for (const field of [
        "content-type",
        "accept",
        "range",
        "if-range",
        "upload-offset",
        "content-length",
        "upload-length",
        "x-chunk-sha256",
      ])
        if (request.headers.has(field))
          headers.set(field, request.headers.get(field));
      if (token)
        headers.set("Authorization", "Bearer " + token);
      const upstream = await fetch(
          connection.settings.serverURL + url.pathname + url.search,
          {
            method: request.method,
            headers,
            ...(!["GET", "HEAD"].includes(request.method)
              ? { body: request.body, duplex: "half" }
              : {}),
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(
                options.timeoutMs??(url.pathname.startsWith("/api/assets/") ||
                  url.pathname.startsWith("/api/client-releases/") ||
                  url.pathname.includes("/chunk")
                  ? 5 * 60 * 1000
                  : 10000),
              ),
            ]),
          },
        ),
        type =
          upstream.headers.get("content-type") || "application/octet-stream";
      if(!active()){await upstream.body?.cancel().catch(()=>{});return switched();}
      const changedAccess=await store?.deniedResponse?.(request,url);if(changedAccess){await upstream.body?.cancel().catch(()=>{});return changedAccess;}
      if(note&&[403,404].includes(upstream.status)&&!(previewRead&&upstream.status===404))await store?.denyDocument(note[1],upstream.status,"服务器笔记已删除或访问权限已变化，本地副本已保留");
      if(upstream.status>=500){store?.setNetworkOnline(false);const cached=await local();if(cached)return cached;}
      else if(upstream.ok)store?.setNetworkOnline(true);
      if(upstream.ok&&request.method==="PATCH"&&note){
        try{const value=await upstream.clone().json();if(active())await store?.observe(url,value);}catch{}
      }
      if (upstream.ok && ((request.method === "PATCH" && url.pathname === "/api/me/profile") || (request.method === "GET" && url.pathname === "/api/me"))) {
        const account = await upstream.clone().json();
        if(!active())return switched();
        if (account.id === session.settings.user?.id && typeof account.name === "string" && account.name !== session.settings.user.name) {
          session.settings.user = { ...session.settings.user, name: account.name };
          await session.save();
          notify();
        }
      }
      const responseHeaders = new Headers({
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      for (const field of [
        "accept-ranges",
        "content-range",
        "content-length",
        "content-disposition",
        "etag",
        "content-security-policy",
        "x-content-type-options",
        "referrer-policy",
      ])
        if (upstream.headers.has(field))
          responseHeaders.set(field, upstream.headers.get(field));
      const small =
        (cacheable||observeJSON) &&
        Number(upstream.headers.get("content-length") || Infinity) <
          8 * 1024 ** 2;
      if (!small)
        return new Response(request.method === "HEAD" ? null : upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      let bytes = Buffer.from(await upstream.arrayBuffer());
      if(!active())return switched();
      if(upstream.ok&&request.method==="GET"&&type.includes("application/json")){
        try{
          const value=JSON.parse(bytes.toString("utf8"));
          if(store&&previewRead&&note){const {snapshot:_snapshot,...metadata}=value;void store.observeBackground(new URL('/api/documents/'+note[1],url),metadata);}
          else if(store&&/^\/api\/documents\/[-\w]+$/.test(url.pathname))void store.observeBackground(url,value);
          else await store?.observe(url,value);
          if(freshAccess&&note){
            const pendingTitle=store?.pendingTitle(note[1]);let result=pendingTitle===undefined?value:{...value,title:pendingTitle};
            if(previewRead&&store?.hasPending(note[1])){const draft=await store.serial(()=>store.previewRecord(note[1]));if(!active())return switched();if(draft?.snapshot)result={...result,snapshot:draft.snapshot,preview_source:'local-draft',local_revision:draft.local_revision};}
            bytes=Buffer.from(JSON.stringify(result));
          }
          if(url.pathname==="/api/teams"&&workspaceContexts.observe(session,value))notify();
        }catch{}
      }
      if (cacheable&&upstream.ok && bytes.length < 8 * 1024 ** 2)
        await atomicJSON(file, {
          type,
          body: bytes.toString("base64"),
          at: new Date().toISOString(),
        });
      if ([401, 403].includes(upstream.status))
        await fs.unlink(file).catch(() => {});
      return new Response(bytes, {
        status: upstream.status,
        headers: {
          "Content-Type": type,
          "Cache-Control": "no-store",
          ...(upstream.headers.has("content-range")
            ? { "Content-Range": upstream.headers.get("content-range") }
            : {}),
        },
      });
    } catch (error) {
      if(!active())return switched();
      if(!connection.settings.offline)store?.setNetworkOnline(false);
      const cachedOffline=await local();if(cachedOffline)return cachedOffline;
      const restricted=await store?.deniedResponse?.(request,url);if(restricted)return restricted;
      const cachedAsset = await localAsset(request, url, connection,allowLegacyDocument).catch(() => null);
      if (cachedAsset) return cachedAsset;
      if (cacheable) {
        const cached = await readJSON(file, null);
        if (cached)
          return new Response(Buffer.from(cached.body, "base64"), {
            headers: {
              "Content-Type": cached.type,
              "X-ANote-Cache": "offline",
              "Cache-Control": "no-store",
            },
          });
      }
      return Response.json(
        {
          error: connection.settings.offline
            ? "当前离线，此内容尚未缓存"
            : error.message,
        },
        { status: 503 },
      );
    }
  }
  protocol.handle("anote", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app")
      return new Response("Not found", { status: 404 });
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/fixtures/")
    )
      return proxy(request, url);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1)),
      file = path.resolve(webRoot, relative);
    if (!file.startsWith(webRoot + path.sep))
      return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).href);
  });
  handle("locale", (locale) => { setLocale(locale); });
  handle("state", () => snapshot());
  handle('local-mcp-state',async()=>{await localMcp.sync();return localMcp.state();});
  handle('local-mcp-configure',input=>localMcp.configure(input));
  handle("storage-directory", () => ({directory:personal?.directory || session.dataRoot,kind:personal?"personal":"server",migrating:storageMigrating}));
  handle("storage-retry", async () => {
    if (unavailablePersonalDirectory) {
      await assertPersonalDirectory(unavailablePersonalDirectory);
      personal=await new PersonalStore(unavailablePersonalDirectory).load();
      unavailablePersonalDirectory=""; storageError="";
    }
    await loadServerStores(); notify(); return snapshot();
  });
  handle("storage-migrate", async () => {
    if (selectingStorage || storageMigration) throw new Error("正在选择或迁移工作目录，请等待完成");
    if (!personal && !session.settings.user) throw new Error("请先打开个人笔记或连接服务器");
    selectingStorage = true;
    let chosen;
    try { chosen = await dialog.showOpenDialog(window,{title:t("选择新的笔记与附件工作目录"),properties:["openDirectory","createDirectory"]}); }
    finally { selectingStorage = false; }
    if (chosen.canceled) return snapshot();
    const directory = await fs.realpath(chosen.filePaths[0]);
    const oldPersonal = personal, oldSettings = structuredClone(session.settings);
    const source = oldPersonal?.root || session.dataRoot;
    const destination = path.join(directory,oldPersonal?".anote":".anote-server-"+session.profileKey.slice(0,16));
    if ((oldPersonal?.directory || session.dataRoot) === directory) return snapshot();
    storageMigrating = true; notify();
    storageMigration = (async () => {
      await flushRenderer();
      storageFrozen = true;
      if (oldPersonal) { clearInterval(oldPersonal.timer); await oldPersonal.queue; }
      else { await offlineStore?.close(); await sync?.close(); }
      if (!oldPersonal && oldSettings.documents.some(doc => !/^[\w-]{1,80}$/.test(doc.id) || typeof doc.directory !== "string"))
        throw new Error("本地笔记工作目录记录无效，原文件已保留");
      const extraSources = oldPersonal ? [] : oldSettings.documents.filter(doc => !doc.directory.startsWith(source + path.sep)).map(doc => ({source:doc.directory,relative:"managed-markdown/"+doc.id}));
      await migrateStorageTree({source,destination,skip:oldPersonal?["lock.json"]:[],extraSources,commit:async target => {
        if (oldPersonal) {
          const next = await new PersonalStore(path.dirname(target)).load();
          try { await savePersonalMode(next.directory); }
          catch (error) { await next.close(); throw error; }
          personal = next;
          await oldPersonal.close().catch(()=>{});
        } else {
          await atomicJSON(path.join(target,".anote-storage.json"),{profileKey:session.profileKey,serverURL:session.settings.serverURL,userId:session.settings.user.id});
          session.settings.dataDirectory = target;
          if (oldSettings.documents.length) {
            session.settings.workspace = path.join(target,"managed-markdown");
            session.settings.documents = oldSettings.documents.map(doc => ({...doc,directory:doc.directory.startsWith(source+path.sep)?path.join(target,path.relative(source,doc.directory)):path.join(target,"managed-markdown",doc.id)}));
          }
          let nextSync, nextOffline;
          try {
            nextSync = await new SyncService(session,notify).load();
            nextOffline = await new OfflineStore(session,notify,{backupWorker:path.join(app.getAppPath(),"dist/backup-worker.cjs"),documentWorker:path.join(app.getAppPath(),"dist/document-worker.cjs")}).load();
            await session.save();
          } catch (error) {
            await nextSync?.close(); await nextOffline?.close();
            session.settings = oldSettings; await session.save().catch(()=>{});
            throw error;
          }
          sync = nextSync; offlineStore = nextOffline;
        }
      }});
    })();
    try {
      await storageMigration;
      setImmediate(()=>window.webContents.reload());
    } catch (error) {
      if (oldPersonal) {
        await oldPersonal.close();
        personal = await openExistingPersonal(oldPersonal.directory);
      } else {
        session.settings = oldSettings;
        await loadServerStores();
      }
      throw error;
    } finally { storageMigration=null; storageMigrating=false; storageFrozen=false; notify(); }
    return snapshot();
  });
  handle("renderer-ready",()=>updater.acknowledgeInstall());
  handle("offline-status",()=>offlineStore?.status()||{config:{enabled:false,scope:"all-readable",libraryIds:[],includeAssets:true,backupDirectory:"",retention:10,backupIntervalMinutes:15},enabled:false,configured:false,libraries:[],backups:[],progress:null,networkOnline:false,automaticOffline:false,running:false,lastError:"请先连接平台账号",lastDownload:null,lastBackup:null,documents:0,pending:0,conflicts:[],assets:0});
  const offline=()=>{if(!offlineStore||personal)throw new Error("请先连接平台账号后设置离线副本");return offlineStore;};
  handle("offline-configure",input=>offline().configure(input));
  handle("offline-download",()=>offline().download());
  handle("offline-sync",()=>offline().sync());
  handle("offline-cache-document",input=>{
    const store=offline();
    if(store.closed||input?.serverURL!==store.identity.serverURL||input?.userId!==store.identity.userId)throw new Error("账号或服务器已切换，旧页面已停止保存");
    return store.cacheDocument(input);
  });
  handle("backup-directory",async()=>{const chosen=await dialog.showOpenDialog(window,{title:t("选择独立备份目录"),properties:["openDirectory","createDirectory"]});if(chosen.canceled)return null;return fs.realpath(chosen.filePaths[0]);});
  handle("backup-create",async()=>{
    if(connecting)throw new Error("请先完成或取消当前服务器连接");
    const store=offline();backupBusy=true;notify();
    try{await flushRenderer();return await store.backup();}finally{backupBusy=false;notify();}
  });
  handle("backup-list",()=>offline().listBackups());
  handle("backup-delete",async id=>{
    if(connecting)throw new Error("请先完成或取消当前服务器连接");
    const store=offline();backupBusy=true;notify();
    try{return await store.deleteBackup(id);}finally{backupBusy=false;notify();}
  });
  handle("backup-restore",async id=>{
    if(connecting)throw new Error("请先完成或取消当前服务器连接");
    const store=offline();backupRestoring=true;notify();
    try{
      await flushRenderer();await store.restore(id);
      await window.loadURL(window.webContents.getURL());
      return store.status();
    }finally{backupRestoring=false;notify();}
  });
  handle("backup-open",async()=>{const directory=offline().status().config.backupDirectory;if(!directory)throw new Error("请先选择备份目录");const error=await shell.openPath(directory);if(error)throw new Error(error);});
  handle("offline-resolve",(id,choice)=>offline().resolveConflict(id,choice));
  handle("update-state",()=>updater.snapshot());
  handle("update-check",()=>checkClientUpdates({force:true}));
  handle("update-online",()=>checkClientUpdates({event:true}));
  handle("update-download",()=>updater.download({serverURL:session.settings.serverURL,token:session.token}));
  handle("update-open",()=>{const file=updater.snapshot().downloadPath;if(!file)throw new Error("尚未下载更新包");shell.showItemInFolder(file);});
  handle("update-install",async()=>{
    const plan=await updater.prepareInstall();
    let closed=false;const personalDirectory=personal?.directory;
    try{
      await flushRenderer();
      if(offlineStore?.status().config.backupDirectory)await offlineStore.backup();
      closed=true;await sync?.close();await offlineStore?.close();await personal?.close();
      await updater.launchInstall(plan);
    }catch(error){
      await updater.discardInstall(plan,error).catch(()=>{});
      if(closed){if(personalDirectory)personal=await openExistingPersonal(personalDirectory);else await loadServerStores();}
      notify();throw error;
    }
    app.exit(0);
  });
  handle("note-export-pdf",input=>exportNotePDF(window,input));
  handle('note-export-markdown',input=>{
    const selectedPersonal=personal,selectedStore=offlineStore,serverURL=session.settings.serverURL,userId=session.settings.user?.id;
    const active=()=>!!window&&!window.isDestroyed()&&!storageFrozen&&!storageMigrating&&!switchingWorkspace&&personal===selectedPersonal&&offlineStore===selectedStore&&(!!selectedPersonal||session.settings.serverURL===serverURL&&session.settings.user?.id===userId);
    const get=async id=>{if(!active())throw new Error('工作空间已切换，已取消导出');const url=new URL('anote://app/api/assets/'+id);return proxy(new Request(url),url);};
    return exportNoteMarkdown(window,input,{active,baseURL:selectedPersonal?'':serverURL,metadata:async id=>{const response=await get(id);if(!response.ok)throw new Error('无法读取附件信息（'+response.status+'）');const asset=await response.json();return {id:asset.id,filename:asset.filename,bytes:Number(asset.bytes),mime:asset.mime};},read:async id=>{if(!active())throw new Error('工作空间已切换，已取消导出');const url=new URL('anote://app/api/assets/'+id+'/file');return proxy(new Request(url),url,{timeoutMs:30*60*1000});},progress:message=>{if(window&&!window.isDestroyed())window.webContents.send('anote:note-export-progress',{id:input.exportId,message});}});
  });
  async function enterPersonalWorkspace(reuse=false){
    if(switchingWorkspace||connecting)throw new Error("正在切换或连接工作空间，请稍后");
    if(reuse&&personal)return snapshot();
    switchingWorkspace=true;notify();
    try{
    const saved=await readJSON(modeFile,{}),remembered=reuse&&(saved.directory||saved.lastDirectory);
    const result = remembered?{canceled:false,filePaths:[remembered]}:await dialog.showOpenDialog(window, {
      title: t("选择个人笔记保存目录"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return snapshot();
    const directory = await fs.realpath(result.filePaths[0]);
    if (personal?.directory === directory) return snapshot();
    if(remembered)await assertPersonalDirectory(directory);
    await flushRenderer();
    const next = await new PersonalStore(directory).load();
    const previous=personal;
    try{
      await sync?.close();await offlineStore?.close();
      await personal?.close();
      await savePersonalMode(directory);
    }catch(error){
      await next.close().catch(()=>{});
      if(previous)personal=await openExistingPersonal(previous.directory);
      else await loadServerStores();
      throw error;
    }
    offlineStore=undefined;sync=undefined;
    personal = next;
    unavailablePersonalDirectory=""; storageError="";
    notify();
    return snapshot();
    }finally{switchingWorkspace=false;notify();}
  }
  handle("personal-enter",()=>enterPersonalWorkspace());
  handle("workspace-local",()=>enterPersonalWorkspace(true));
  handle("workspace-context",()=>workspaceContexts.refresh(session,{network:true}));
  handle("workspace-server",async input=>{
    if(!session.settings.user||!session.settings.serverURL)return false;
    const scope=input?.scope||"personal",page=input?.page||"home";
    if(typeof scope!=="string"||!/^[-\w]{1,80}$/.test(scope)||!["home","friends","teams"].includes(page))throw new Error("工作空间参数无效");
    if(switchingWorkspace||connecting)throw new Error("正在切换或连接工作空间，请稍后");
    switchingWorkspace=true;notify();
    let nextSync,nextOffline;
    const previous=personal;
    try{
    if(page!=="home"){
      if(!session.token)return false;
      const response=await fetch(session.settings.serverURL+"/api/me",{headers:{Authorization:"Bearer "+session.token},redirect:"error",signal:AbortSignal.timeout(8000)});
      await response.body?.cancel().catch(()=>{});
      if([401,403].includes(response.status))return false;
      if(!response.ok)throw new Error("服务器暂时不可用，请稍后重试");
    }
    await assertStorageDirectory(session);
      await flushRenderer();
      if(personal){
        nextSync=await new SyncService(session,notify).load();
        nextOffline=await new OfflineStore(session,notify,{backupWorker:path.join(app.getAppPath(),"dist/backup-worker.cjs"),documentWorker:path.join(app.getAppPath(),"dist/document-worker.cjs")}).load();
        await personal.close();
        try{await savePersonalMode(null,previous.directory);}catch(error){personal=await openExistingPersonal(previous.directory);throw error;}
        personal=undefined;sync=nextSync;offlineStore=nextOffline;
        unavailablePersonalDirectory="";storageError="";
      }
      const params=new URLSearchParams({page,scope});
      setImmediate(()=>{if(window&&!window.isDestroyed())void window.loadURL("anote://app/?"+params).catch(error=>{session.credentialWarning="工作空间已保存，请重新打开客户端："+error.message;notify();});});
      return true;
    }catch(error){if(personal){await nextSync?.close().catch(()=>{});await nextOffline?.close().catch(()=>{});}throw error;}
    finally{switchingWorkspace=false;notify();}
  });
  handle("personal-leave", async () => {
    await flushRenderer();
    await personal?.close();
    personal = undefined;
    await savePersonalMode(null);
    unavailablePersonalDirectory=""; storageError="";
    await loadServerStores();
    notify();
    return snapshot();
  });
  handle("personal-folder", async () => {
    if (!personal) throw new Error("当前不是本地个人模式");
    const directory = await personal.safe("markdown");
    await fs.mkdir(directory, { recursive: true });
    await shell.openPath(directory);
    return { ok: true };
  });
  let connecting=false,connectionRevision=0;
  async function establishServer(operation){
    if(connecting)throw new Error("正在连接服务器，请完成或取消当前登录");
    connecting=true;const revision=++connectionRevision;let prepared=false,frozen=false;
    try{
      await operation(async()=>{
        if(revision!==connectionRevision)throw new Error("已取消服务器连接");
        switchingWorkspace=true;frozen=true;notify();
        prepared=true;
        await closeConnection();
        if(revision!==connectionRevision)throw new Error("已取消服务器连接");
      });
      if(personal){
        const previous=personal;
        await previous.close();
        try{await savePersonalMode(null,previous.directory);}catch(error){personal=await openExistingPersonal(previous.directory);throw error;}
        personal=undefined;
      }
      if(unavailablePersonalDirectory){await savePersonalMode(null,unavailablePersonalDirectory);unavailablePersonalDirectory="";storageError="";}
      await loadServerStores();void checkClientUpdates({force:true}).catch(()=>{});
      notify();void sync?.drain();return snapshot();
    }catch(error){
      if(prepared&&!personal){await loadServerStores();notify();}
      throw error;
    }finally{connecting=false;if(frozen){switchingWorkspace=false;notify();}}
  }
  handle("connect", async (input) => {
    if (
      typeof input?.serverURL !== "string" ||
      typeof input.username !== "string" ||
      typeof input.password !== "string"
    )
      throw new Error("登录信息不完整");
    sso.cancel?.();
    return establishServer(beforeSwitch=>session.connect(input,beforeSwitch));
  });
  handle("casdoor-providers", (serverURL) => sso.providers(serverURL));
  handle("cancel-casdoor", () => {
    connectionRevision++;
    sso.cancel?.();
    return { ok: true };
  });
  handle("connect-casdoor", async (input) => {
    if (
      typeof input?.serverURL !== "string" ||
      ![undefined, "login", "link"].includes(input.intent)
    )
      throw new Error("登录参数无效");
    if(personal&&input.intent==="link")throw new Error("请先连接服务器账号，再绑定统一登录");
    if (
      input.intent === "link" &&
      input.serverURL.replace(/\/$/, "") !== session.settings.serverURL
    )
      throw new Error("只能绑定当前服务的账号");
    const previousId = session.settings.user?.id;
    return establishServer(async beforeSwitch=>{
      const result=await sso.connect(input,input.intent==="link"?session.token:undefined);
      if(input.intent==="link"&&result.user.id!==previousId)throw new Error("绑定账号不一致");
      await session.acceptSession(input.serverURL,result,beforeSwitch);
    });
  });
  handle("logout", async () => {
    if(connecting)throw new Error("请先完成或取消当前服务器连接");
    switchingWorkspace=true;notify();
    const previous=personal;let closedPersonal=false;
    try{
      sso.cancel?.();
      await flushRenderer();
      if(previous){
        // Keep all local requests routed to the personal store until the
        // remote logout and local mode pointer are durably committed.
        await session.logout();
        await previous.close();closedPersonal=true;
        await savePersonalMode(null,previous.directory);
        personal=undefined;
      }else{
        await sync?.close();await offlineStore?.close();offlineStore=undefined;
        await session.logout();
      }
      await loadServerStores();
      return snapshot();
    }catch(error){
      if(previous){
        if(closedPersonal)personal=await openExistingPersonal(previous.directory);
        await savePersonalMode(previous.directory).catch(()=>{});
      }else await loadServerStores().catch(()=>{});
      throw error;
    }finally{switchingWorkspace=false;notify();}
  });
  handle("offline", async (value) => {
    session.settings.offline = !!value;
    await session.save();
    if(!value)void offlineStore?.maintenance().catch(()=>{});
    notify();
    if (!value) void sync?.drain();
    return snapshot();
  });
  handle("workspace", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("选择 ANote 本地笔记目录"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    const selected = await fs.realpath(result.filePaths[0]);
    if (!(await fs.stat(selected)).isDirectory()) throw new Error("请选择目录");
    await session.chooseWorkspace(selected);
    notify();
    return selected;
  });
  handle("checkout", async (input) =>
    sync.checkout(String(input?.id || ""), String(input?.title || "")),
  );
  handle("sync", async (id) => {
    if (!session.settings.documents.some((d) => d.id === id))
      throw new Error("此文档未加入本地同步");
    return sync.schedule(id, true);
  });
  handle("accept-remote", async (id) => sync.acceptRemote(id));
  handle("select-document", async (id, scope) => {
    const current = snapshot();
    if (scope !== undefined && scope !== current.serverURL+"|"+(current.user?.id || "")) return;
    if (id !== null && !/^[\w-]{1,80}$/.test(id))
      throw new Error("文档 ID 无效");
    if (personal) {
      const store = personal;
      if(id && !store.index.documents.some(note=>note.id===id && !note.deleted_at)) return;
      await store.mutate(() => {
        store.index.lastDoc = id;
      });
    } else {
      session.settings.lastDoc = id;
      await session.save();
    }
  });
  const initialTheme = personal?.index.theme || session.settings.user?.theme || "auto";
  const initialDark = initialTheme === "dark" || (initialTheme === "auto" && nativeTheme.shouldUseDarkColors);
  const applicationIcon = path.join(app.getAppPath(), "assets", "anote.png");
  if (process.platform === "darwin") app.dock?.setIcon(applicationIcon);
  window = new BrowserWindow({
    width: 1480,
    height: 1000,
    minWidth: 1000,
    minHeight: 680,
    title: "ANote",
    icon: applicationIcon,
    backgroundColor: initialDark ? "#141b25" : "#ffffff",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    else if(!personal&&session.settings.serverURL){
      try{
        const link=new URL(url),note=link.searchParams.get("doc");
        if(link.protocol==="anote:"&&link.hostname==="app"&&link.pathname==="/"&&!link.hash&&link.searchParams.size===1&&note&&/^[-\w]{1,80}$/.test(note)){
          const target=new URL(session.settings.serverURL);
          if(["http:","https:"].includes(target.protocol)&&!target.username&&!target.password){target.pathname="/";target.search=new URLSearchParams({doc:note}).toString();target.hash="";void shell.openExternal(target.href);}
        }
      }catch{/* Only canonical same-server note URLs may leave the native origin. */}
    }
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    const entries=[];
    if (["image","video","audio"].includes(params.mediaType) && params.srcURL.startsWith("anote://app/api/")) {
      entries.push({label:params.mediaType==="image"?"图片另存为…":params.mediaType==="video"?"视频另存为…":"音频另存为…",click:async()=>{
        const result=await dialog.showSaveDialog(window,{defaultPath:params.suggestedFilename||params.altText||params.mediaType});
        if(result.canceled||!result.filePath)return;
        const temporary=result.filePath+"."+randomUUID()+".download";
        try{
          const response=await net.fetch(params.srcURL);
          if(!response.ok||!response.body)throw new Error("无法读取资源");
          await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:"wx"}));
          await fs.rename(temporary,result.filePath);
        }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});dialog.showErrorBox("保存失败",String(error.message||error));}
      }});
    }
    if(params.isEditable)entries.push({role:"undo"},{role:"redo"},{type:"separator"},{role:"cut"},{role:"copy"},{role:"paste"},{role:"selectAll"});
    else if(params.selectionText)entries.push({role:"copy"});
    if(entries.length)Menu.buildFromTemplate(entries).popup({window});
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("anote://app/")) event.preventDefault();
  });
  window.on("focus",()=>void checkClientUpdates({event:true}).catch(()=>{}));
  await window.loadURL(
    "anote://app/" +
      (requestedDoc ? "?doc=" + encodeURIComponent(requestedDoc) : ""),
  );
  void checkClientUpdates().catch(()=>{});void offlineStore?.maintenance().catch(()=>{});
  const updateTimer=setInterval(()=>void checkClientUpdates().catch(()=>{}),30*1000);updateTimer.unref();
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
        await storageMigration?.catch(()=>{});
        if (window && !window.isDestroyed()) {
          const nonce = randomUUID();
          await new Promise((resolve, reject) => {
            const listener = (event, result) => {
              try {
                allowed(event);
              } catch {
                return;
              }
              if (result?.nonce !== nonce) return;
              clearTimeout(timer);
              ipcMain.removeListener("anote:close-ready", listener);
              result.ok
                ? resolve()
                : reject(new Error(result.error || "本地保存失败"));
            };
            const timer = setTimeout(() => {
              ipcMain.removeListener("anote:close-ready", listener);
              reject(new Error("本地保存确认超时"));
            }, 8000);
            ipcMain.on("anote:close-ready", listener);
            window.webContents.send("anote:before-close", nonce);
          });
        }
        await sync?.close();
        await offlineStore?.close();
        await localMcp?.stop();
        await personal?.close();
        app.quit();
      } catch (error) {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          title: t("本地保存尚未完成"),
          message: t("关闭前未能确认笔记已保存。"),
          detail: error.message,
          buttons: ["返回继续编辑", "仍然关闭"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response === 1) {
          await sync?.close();
          await offlineStore?.close();
          await personal?.close();
          app.quit();
        } else quitting = false;
      }
    })();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
}
void start().catch((error) => {
  console.error("ANote startup failed:", error.message);
  app.exit(1);
});
