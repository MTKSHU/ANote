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
import { setLocale, t } from "@anote/i18n";

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
if (process.env.ANOTE_CLIENT_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.ANOTE_CLIENT_DATA_DIR));
const requestedDoc = process.argv
  .find((v) => v.startsWith("--document="))
  ?.slice(11);
let window, session, sync, personal;
const sso = new CasdoorLogin((url) => shell.openExternal(url));
let stateRevision = 0;
const snapshot = () => ({
  desktop: true,
  stateRevision,
  ...(personal ? personal.state() : session.state()),
  sync: personal
    ? { pending: [], documents: [] }
    : sync?.status() || { pending: [], documents: [] },
  testing: process.env.ANOTE_DESKTOP_TEST === "1",
});
const notify = () => {
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
    return fn(...args);
  });
handle("locale", (locale) => { setLocale(locale); });

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

async function start() {
  await app.whenReady();
  session = await new SessionStore(app.getPath("userData"), safeStorage).load();
  const modeFile = path.join(app.getPath("userData"), "personal-mode.json"),
    savedMode = await readJSON(modeFile, {});
  if (savedMode.directory) {
    try {
      personal = await new PersonalStore(savedMode.directory).load();
    } catch (error) {
      session.credentialWarning = error.message;
    }
  }
  if (!personal) sync = await new SyncService(session, notify).load();
  const webRoot = path.join(app.getAppPath(), "dist", "web"),
    cacheRoot = path.join(session.root, "http-cache");
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  async function proxy(request, url) {
    if (personal) {
      const response = await personal.respond(request, url);
      if (response.ok && request.method === "PATCH" && url.pathname === "/api/me/profile") notify();
      return response;
    }
    const cacheable =
      request.method === "GET" &&
      !url.pathname.startsWith("/api/auth/") &&
      !url.pathname.startsWith("/api/assets/") &&
      !request.headers.has("range");
    const key = createHash("sha256")
        .update(
          session.settings.serverURL +
            "|" +
            session.settings.user?.id +
            "|" +
            url.pathname +
            url.search,
        )
        .digest("hex"),
      file = path.join(cacheRoot, key + ".json");
    if (!session.settings.serverURL)
      return Response.json({ error: "请先连接研究空间" }, { status: 503 });
    try {
      if (session.settings.offline) {
        const local = await localAsset(request, url, session);
        if (local) return local;
      }
      if (session.settings.offline) throw new Error("客户端处于离线模式");
      const headers = new Headers();
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
      if (session.token)
        headers.set("Authorization", "Bearer " + session.token);
      const upstream = await fetch(
          session.settings.serverURL + url.pathname + url.search,
          {
            method: request.method,
            headers,
            ...(!["GET", "HEAD"].includes(request.method)
              ? { body: request.body, duplex: "half" }
              : {}),
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(
                url.pathname.startsWith("/api/assets/") ||
                  url.pathname.startsWith("/api/client-releases/") ||
                  url.pathname.includes("/chunk")
                  ? 5 * 60 * 1000
                  : 10000,
              ),
            ]),
          },
        ),
        type =
          upstream.headers.get("content-type") || "application/octet-stream";
      if (upstream.ok && ((request.method === "PATCH" && url.pathname === "/api/me/profile") || (request.method === "GET" && url.pathname === "/api/me"))) {
        const account = await upstream.clone().json();
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
      ])
        if (upstream.headers.has(field))
          responseHeaders.set(field, upstream.headers.get(field));
      const small =
        cacheable &&
        Number(upstream.headers.get("content-length") || Infinity) <
          8 * 1024 ** 2;
      if (!small)
        return new Response(request.method === "HEAD" ? null : upstream.body, {
          status: upstream.status,
          headers: responseHeaders,
        });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (upstream.ok && bytes.length < 8 * 1024 ** 2)
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
      const local = await localAsset(request, url, session).catch(() => null);
      if (local) return local;
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
          error: session.settings.offline
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
  handle("state", () => snapshot());
  handle("personal-enter", async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("选择个人笔记保存目录"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return snapshot();
    const directory = await fs.realpath(result.filePaths[0]);
    if (personal?.directory === directory) return snapshot();
    await flushRenderer();
    const next = await new PersonalStore(directory).load();
    await sync?.close();
    sync = undefined;
    await personal?.close();
    personal = next;
    await atomicJSON(modeFile, { directory });
    notify();
    return snapshot();
  });
  handle("personal-leave", async () => {
    await flushRenderer();
    await personal?.close();
    personal = undefined;
    await atomicJSON(modeFile, {});
    sync = await new SyncService(session, notify).load();
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
  handle("connect", async (input) => {
    if (personal) throw new Error("请先切换到团队连接");
    if (
      typeof input?.serverURL !== "string" ||
      typeof input.username !== "string" ||
      typeof input.password !== "string"
    )
      throw new Error("登录信息不完整");
    sso.cancel?.();
    await session.connect(input, () => sync.close());
    sync = await new SyncService(session, notify).load();
    notify();
    void sync.drain();
    return snapshot();
  });
  handle("casdoor-providers", (serverURL) => sso.providers(serverURL));
  handle("cancel-casdoor", () => {
    sso.cancel?.();
    return { ok: true };
  });
  handle("connect-casdoor", async (input) => {
    if (personal) throw new Error("请先切换到团队连接");
    if (
      typeof input?.serverURL !== "string" ||
      ![undefined, "login", "link"].includes(input.intent)
    )
      throw new Error("登录参数无效");
    if (
      input.intent === "link" &&
      input.serverURL.replace(/\/$/, "") !== session.settings.serverURL
    )
      throw new Error("只能绑定当前服务的账号");
    const previousId = session.settings.user?.id;
    const result = await sso.connect(
      input,
      input.intent === "link" ? session.token : undefined,
    );
    if (input.intent === "link" && result.user.id !== previousId)
      throw new Error("绑定账号不一致");
    await session.acceptSession(input.serverURL, result, () => sync.close());
    sync = await new SyncService(session, notify).load();
    notify();
    void sync.drain();
    return snapshot();
  });
  handle("logout", async () => {
    if (personal) {
      await flushRenderer();
      await personal.close();
      personal = undefined;
      await atomicJSON(modeFile, {});
      sync = await new SyncService(session, notify).load();
      notify();
      return snapshot();
    }
    sso.cancel?.();
    await sync.close();
    await session.logout();
    sync = await new SyncService(session, notify).load();
    notify();
    return snapshot();
  });
  handle("offline", async (value) => {
    session.settings.offline = !!value;
    await session.save();
    notify();
    if (!value) void sync.drain();
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
  window = new BrowserWindow({
    width: 1480,
    height: 1000,
    minWidth: 1000,
    minHeight: 680,
    title: app.getName(),
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
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    const entries=[];
    if (["image","video","audio"].includes(params.mediaType) && params.srcURL.startsWith("anote://app/api/")) {
      entries.push({label:params.mediaType==="image"?t("图片另存为…"):params.mediaType==="video"?t("视频另存为…"):t("音频另存为…"),click:async()=>{
        const result=await dialog.showSaveDialog(window,{defaultPath:params.suggestedFilename||params.altText||params.mediaType});
        if(result.canceled||!result.filePath)return;
        const temporary=result.filePath+"."+randomUUID()+".download";
        try{
          const response=await net.fetch(params.srcURL);
          if(!response.ok||!response.body)throw new Error("无法读取资源");
          await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary,{flags:"wx"}));
          await fs.rename(temporary,result.filePath);
        }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});dialog.showErrorBox(t("保存失败"),t(String(error.message||error)));}
      }});
    }
    if(params.isEditable)entries.push({role:"undo"},{role:"redo"},{type:"separator"},{role:"cut"},{role:"copy"},{role:"paste"},{role:"selectAll"});
    else if(params.selectionText)entries.push({role:"copy"});
    if(entries.length)Menu.buildFromTemplate(entries).popup({window});
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("anote://app/")) event.preventDefault();
  });
  await window.loadURL(
    "anote://app/" +
      (requestedDoc ? "?doc=" + encodeURIComponent(requestedDoc) : ""),
  );
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      try {
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
        await personal?.close();
        app.quit();
      } catch (error) {
        const result = await dialog.showMessageBox(window, {
          type: "warning",
          title: t("本地保存尚未完成"),
          message: t("关闭前未能确认笔记已保存。"),
          detail: t(error.message),
          buttons: [t("返回继续编辑"), t("仍然关闭")],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response === 1) {
          await sync?.close();
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
