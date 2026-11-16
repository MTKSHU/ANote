import { updateFS as fs, updateReadStream as createReadStream } from "./update-fs.mjs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { extractUpdate, validateBundle } from "./update-archive.mjs";
import { launchPreparedInstall } from "./updater-install.mjs";

const MAX_DOWNLOAD = 1024 ** 3;
const supported = new Set(["linux-x64", "win32-x64", "darwin-x64", "darwin-arm64"]);

export function parseReleaseVersion(value) {
  // Production desktop releases are stable versions. Reject coercion, leading
  // zeroes, prereleases and build suffixes rather than accidentally downgrade.
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("客户端发布版本格式无效");
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("客户端发布版本超出范围");
  return parts;
}
export function newerVersion(candidate, current) {
  const next = parseReleaseVersion(candidate), previous = parseReleaseVersion(current);
  for (let i = 0; i < 3; i++) if (next[i] !== previous[i]) return next[i] > previous[i];
  return false;
}
function trustedServer(value, allowHTTP) {
  let url; try { url = new URL(value); } catch { throw new Error("请先连接有效的服务器地址"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.protocol !== "https:" && !(allowHTTP && url.protocol === "http:")) throw new Error("在线更新需要已连接的 HTTPS 服务器");
  return url.origin;
}
function releaseFrom(manifest, { currentVersion, platform, arch, origin }) {
  if (!manifest || !Array.isArray(manifest.packages) || manifest.packages.length > 20) throw new Error("客户端发布信息无效");
  if (manifest.version === null && manifest.packages.length === 0) return null;
  parseReleaseVersion(manifest.version);
  if (!newerVersion(manifest.version, currentVersion)) return null;
  const matches = manifest.packages.filter((pkg) => pkg?.platform === platform && pkg?.arch === arch);
  if (matches.length !== 1) throw new Error("暂无适用于此操作系统和架构的更新包");
  const pkg = matches[0], extension = platform === "win32" ? ".zip" : ".tar.gz";
  const brand = ["ANote", "SimpleNote"].find((name) => pkg.file === `${name}-${manifest.version}-${platform}-${arch}${extension}`);
  const expected = brand ? `${brand}-${manifest.version}-${platform}-${arch}${extension}` : null;
  if (!brand || pkg.file !== expected || !Number.isSafeInteger(pkg.bytes) || pkg.bytes < 1 || pkg.bytes > MAX_DOWNLOAD || typeof pkg.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error("客户端更新包清单无效");
  const expectedURL = origin + "/api/client-releases/" + encodeURIComponent(expected);
  let url; try { url = new URL(pkg.url, origin); } catch { throw new Error("更新包地址无效"); }
  if (url.href !== expectedURL) throw new Error("拒绝非当前服务器的更新包地址");
  return { version: manifest.version, platform, arch, brand, file: pkg.file, bytes: pkg.bytes, sha256: pkg.sha256, url: url.href, origin };
}
async function hashFile(filename) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest("hex");
}
async function regularSize(filename) {
  try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("更新缓存不是普通文件"); return stat.size; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}
function errorMessage(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "更新请求已取消或超时，可重新下载";
  return error instanceof Error ? error.message : "更新操作失败";
}
const usableToken = (value) => typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value);
async function boundedJSON(response) {
  let content = "";
  if (!response.body) throw new Error("服务器未返回发布信息");
  for await (const chunk of response.body) { content += Buffer.from(chunk).toString("utf8"); if (content.length > 128 * 1024) throw new Error("客户端发布信息过大"); }
  return JSON.parse(content);
}

export class DesktopUpdater {
  constructor({ directory, currentVersion, platform = process.platform, arch = process.arch, execPath = process.execPath, isPackaged = false, onChange = () => {}, allowHTTP = false, fetchImpl = globalThis.fetch }) {
    parseReleaseVersion(currentVersion);
    this.directory = path.resolve(directory); this.currentVersion = currentVersion; this.platform = platform; this.arch = arch;
    this.execPath = path.resolve(execPath); this.isPackaged = isPackaged; this.onChange = onChange; this.allowHTTP = allowHTTP; this.fetch = fetchImpl;
    this.release = null; this.metadataOrigin = null; this.extracted = null; this.busy = false; this.plans = new Set(); this.abortController = null; this.checkPromise = null; this.rejectedCredentials = null;
    this.state = { status: "idle", currentVersion, latestVersion: null, downloadedBytes: 0, totalBytes: 0, progress: 0, error: null, checkedAt: null, downloadPath: null, canInstall: false, release: null, installerResult: null, needsAuth: true };
  }
  snapshot() { return structuredClone(this.state); }
  change(values) { Object.assign(this.state, values); this.onChange(this.snapshot()); }
  async operation(work) {
    if (this.busy || this.plans.size || this.state.status === "installing") throw new Error("已有客户端更新任务正在进行");
    this.busy = true;
    try { return await work(); } catch (error) { this.change({ status: "error", error: errorMessage(error), canInstall: Boolean(this.extracted && this.isPackaged) }); throw error; }
    finally { this.busy = false; this.abortController = null; }
  }
  credentials({ serverURL, token } = {}) {
    const origin = trustedServer(serverURL, this.allowHTTP);
    if (!usableToken(token) || this.rejectedCredentials?.origin === origin && this.rejectedCredentials?.token === token) {
      this.change({ needsAuth: true }); throw new Error("请先连接并登录服务器，再下载客户端更新");
    }
    return { origin, token, headers: { Authorization: "Bearer " + token, "Accept-Encoding": "identity" } };
  }
  async check(credentials) {
    // Startup, focus and periodic triggers may coincide. Never replace an
    // active transfer, a verified bundle or a prepared installation plan.
    if (this.checkPromise) return this.checkPromise;
    if (this.busy || this.plans.size || this.extracted && this.state.downloadPath || ["ready", "downloading", "verifying", "preparing", "installing"].includes(this.state.status)) return this.snapshot();
    this.checkPromise = this.checkNow(credentials);
    try { return await this.checkPromise; } finally { this.checkPromise = null; }
  }
  async checkNow({ serverURL, token } = {}) {
    this.busy = true;
    try {
      const origin = trustedServer(serverURL, this.allowHTTP);
      if (!supported.has(`${this.platform}-${this.arch}`)) throw new Error("暂不支持此操作系统和架构的在线更新");
      // Unverified metadata belongs to the server that advertised it. Clear it
      // before contacting a different server, including version-only results;
      // otherwise a failed new check could pair the old package with a new
      // server's login state. check() protects already verified bundles above.
      const changedOrigin = this.metadataOrigin !== null && this.metadataOrigin !== origin;
      if (changedOrigin) { this.release = null; this.extracted = null; }
      this.metadataOrigin = origin;
      this.change({ ...(changedOrigin ? { latestVersion: null, release: null, checkedAt: null, totalBytes: 0, downloadedBytes: 0, progress: 0, canInstall: false, downloadPath: null } : {}), status: "checking", error: null, needsAuth: !usableToken(token) || this.rejectedCredentials?.origin === origin && this.rejectedCredentials?.token === token });
      const metadata = await this.checkMetadata(origin, token);
      let release = metadata.release;
      // A version-only fallback must not erase already validated metadata for
      // that same release and origin. Downloads remain authenticated and hashed.
      if (!release && this.release?.origin === origin && this.release?.version === metadata.version) release = this.release;
      if (this.release?.sha256 !== release?.sha256 || this.release?.origin !== release?.origin) this.extracted = null;
      this.release = release;
      const publicRelease = release ? Object.fromEntries(["version", "file", "platform", "arch", "bytes", "sha256"].map((key) => [key, release[key]])) : null;
      this.change({ status: metadata.version && newerVersion(metadata.version, this.currentVersion) ? "available" : "up-to-date", latestVersion: metadata.version, checkedAt: new Date().toISOString(), release: publicRelease, needsAuth: metadata.needsAuth, error: null, totalBytes: release?.bytes || 0, downloadedBytes: 0, progress: 0, canInstall: false, downloadPath: null });
      return this.snapshot();
    } catch (error) {
      // Keep a known newer version/package visible through transient failures.
      this.change({ status: "error", error: errorMessage(error) }); throw error;
    } finally { this.busy = false; }
  }
  async metadataRequest(url, headers = {}) {
    return this.fetch(url, { headers: { "Accept-Encoding": "identity", ...headers }, redirect: "error", signal: AbortSignal.timeout(20000), cache: "no-store" });
  }
  async checkMetadata(origin, token) {
    let needsAuth = !usableToken(token) || this.rejectedCredentials?.origin === origin && this.rejectedCredentials?.token === token;
    // No credential is sent to either public endpoint, even when one exists.
    const query = new URLSearchParams({ brand: "ANote", platform: this.platform, arch: this.arch });
    const response = await this.metadataRequest(origin + "/api/client-releases/check?" + query);
    if (response.ok) {
      const manifest = await boundedJSON(response);
      return { version: manifest.version, release: releaseFrom(manifest, { ...this, origin }), needsAuth };
    }
    await response.body?.cancel().catch(() => {});
    // On older servers /check matches the authenticated :filename handler, so
    // it returns 401 before it can report a missing endpoint.
    if (![401, 403, 404, 405].includes(response.status)) throw new Error(`检查更新失败（HTTP ${response.status}）`);
    if (!needsAuth) {
      const authenticated = await this.metadataRequest(origin + "/api/client-releases?brand=ANote", { Authorization: "Bearer " + token });
      if (authenticated.ok) {
        const manifest = await boundedJSON(authenticated);
        return { version: manifest.version, release: releaseFrom(manifest, { ...this, origin }), needsAuth: false };
      }
      await authenticated.body?.cancel().catch(() => {});
      if ([401, 403].includes(authenticated.status)) {
        this.rejectedCredentials = { origin, token }; needsAuth = true; this.change({ needsAuth: true });
      } else if (![404, 405].includes(authenticated.status)) throw new Error(`检查更新失败（HTTP ${authenticated.status}）`);
    }
    const versionResponse = await this.metadataRequest(origin + "/api/version");
    if (!versionResponse.ok) { await versionResponse.body?.cancel().catch(() => {}); throw new Error("此服务器暂时无法提供公开版本信息，请连接服务器后重试"); }
    const info = await boundedJSON(versionResponse), version = info?.desktop_version;
    if (version !== null) parseReleaseVersion(version);
    return { version, release: null, needsAuth };
  }
  cancel() { this.abortController?.abort(); }
  async download(credentials) {
    return this.operation(async () => {
      const { origin, headers, token } = this.credentials(credentials), release = this.release;
      if (!release || origin !== release.origin) throw new Error("请先为当前服务器检查客户端更新");
      if (!newerVersion(release.version, this.currentVersion)) throw new Error("拒绝安装相同或较旧的客户端版本");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const cache = path.join(this.directory, release.sha256), archive = path.join(cache, release.file), partial = archive + ".partial";
      await fs.mkdir(cache, { recursive: true, mode: 0o700 });
      this.change({ status: "downloading", error: null, downloadPath: null, downloadedBytes: 0, totalBytes: release.bytes, progress: 0, canInstall: false, needsAuth: false });
      let complete = await regularSize(archive) === release.bytes && await hashFile(archive) === release.sha256;
      if (!complete) {
        await fs.rm(archive, { force: true });
        let offset = await regularSize(partial);
        if (offset > release.bytes) { await fs.rm(partial); offset = 0; }
        if (offset !== release.bytes) {
          this.abortController = new AbortController();
          const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(15 * 60 * 1000)]);
          const response = await this.fetch(release.url, { headers: { ...headers, ...(offset ? { Range: `bytes=${offset}-` } : {}) }, redirect: "error", signal, cache: "no-store" });
          if ([401, 403].includes(response.status)) {
            await response.body?.cancel().catch(() => {}); this.rejectedCredentials = { origin, token }; this.change({ needsAuth: true });
            throw new Error("登录已失效，请重新连接服务器后下载更新");
          }
          if (!response.ok || ![200, 206].includes(response.status) || !response.body) throw new Error(`下载更新失败（HTTP ${response.status}）`);
          if (response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity") throw new Error("更新包使用了不支持的传输压缩");
          if (response.status === 206) {
            const expected = `bytes ${offset}-${release.bytes - 1}/${release.bytes}`;
            if (response.headers.get("content-range") !== expected) { await fs.rm(partial, { force: true }); throw new Error("服务器返回了不匹配的续传范围，请重新下载"); }
          } else offset = 0;
          const length = response.headers.get("content-length");
          if (length !== null && Number(length) !== release.bytes - offset) throw new Error("服务器返回的更新包大小与清单不匹配");
          const output = await fs.open(partial, offset ? "a" : "w", 0o600);
          try {
            let lastNotification = 0;
            for await (const value of response.body) {
              const chunk = Buffer.from(value);
              if (offset + chunk.length > release.bytes) throw new Error("下载内容超出更新包清单大小");
              await output.writeFile(chunk); offset += chunk.length;
              if (Date.now() - lastNotification > 100 || offset === release.bytes) { this.change({ downloadedBytes: offset, progress: offset / release.bytes }); lastNotification = Date.now(); }
            }
            await output.sync();
          } finally { await output.close(); }
          if (offset !== release.bytes) throw new Error("更新包下载中断，可重新下载以续传");
        }
        this.change({ status: "verifying" });
        if (await regularSize(partial) !== release.bytes || await hashFile(partial) !== release.sha256) { await fs.rm(partial, { force: true }); throw new Error("更新包 SHA-256 校验失败，请重新下载"); }
        await fs.rename(partial, archive); complete = true;
      }
      this.change({ status: "verifying", downloadedBytes: release.bytes, progress: 1, downloadPath: archive });
      const extracted = path.join(cache, "extracted-" + randomUUID());
      this.extracted = await extractUpdate(archive, extracted, release);
      this.change({ status: "ready", canInstall: this.isPackaged, error: null, needsAuth: false });
      return this.snapshot();
    });
  }
  async prepareInstall() {
    return this.operation(async () => {
      if (!this.isPackaged) throw new Error("开发模式不能替换客户端程序，请使用已发布的客户端安装包");
      if (!this.extracted || !this.release || !newerVersion(this.release.version, this.currentVersion)) throw new Error("请先下载并校验新版本客户端");
      this.change({ status: "preparing", error: null });
      const executable = this.extracted.executable;
      const currentName = path.basename(this.execPath);
      if (!["ANote", "SimpleNote"].some((name) => currentName === name + (this.platform === "win32" ? ".exe" : ""))) throw new Error("当前客户端程序名无法安全识别，请手动安装更新");
      const suffix = this.platform === "darwin" ? path.join("Contents", "MacOS", currentName) : currentName;
      const previousExecutable = this.platform === "darwin" ? "Contents/MacOS/" + currentName : currentName;
      if (!this.execPath.endsWith(path.sep + suffix)) throw new Error("当前客户端安装位置无法安全替换，请打开下载文件手动安装");
      const target = this.execPath.slice(0, -suffix.length - 1), parent = path.dirname(target);
      if (!path.isAbsolute(target) || parent === target || parent === path.parse(parent).root || target === os.homedir() || this.directory === target || this.directory.startsWith(target + path.sep) || target.startsWith(this.directory + path.sep)) throw new Error("客户端程序和用户数据目录重叠，无法在线安装");
      if (await fs.realpath(this.execPath) !== this.execPath || await fs.realpath(target) !== target || await fs.realpath(parent) !== parent) throw new Error("客户端安装路径包含符号链接，请手动安装更新");
      await validateBundle(target, { platform: this.platform, arch: this.arch, version: this.currentVersion });
      const id = randomUUID(), replacement = path.join(parent, ".ANote-update-" + id), backup = path.join(parent, ".ANote-previous-" + id);
      try { await fs.mkdir(replacement, { mode: 0o700 }); }
      catch (error) { throw new Error("客户端安装目录不可写，请打开已下载的更新包手动安装（" + (error.code || "权限不足") + "）"); }
      try {
        // The private destination already exists from the write-permission
        // check. Copy its children with exclusive destinations rather than
        // asking cp(errorOnExist) to overwrite that directory itself.
        for (const entry of await fs.readdir(this.extracted.bundle))
          await fs.cp(path.join(this.extracted.bundle, entry), path.join(replacement, entry), { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
        if (previousExecutable !== executable) {
          // Preserve an existing launcher/shortcut path when a SimpleNote
          // installation later receives an ANote bundle. Fresh ANote packages
          // contain only ANote; the legacy alias exists only in migrated apps.
          const source = path.join(replacement, executable), alias = path.join(replacement, previousExecutable);
          await fs.link(source, alias).catch(async () => fs.copyFile(source, alias, 1));
        }
        await validateBundle(replacement, this.release);
        const jobDirectory = path.join(this.directory, "install-" + id);
        await fs.mkdir(jobDirectory, { mode: 0o700 });
        const plan = Object.freeze({ id, target, replacement, backup, jobDirectory, health: path.join(jobDirectory, "healthy"), result: path.join(jobDirectory, "result.txt"), executable, previousExecutable, brand: this.release.brand, parentPID: process.pid, version: this.release.version, previousVersion: this.currentVersion });
        this.plans.add(plan); this.change({ status: "preparing", canInstall: false }); return plan;
      } catch (error) { await fs.rm(replacement, { recursive: true, force: true }); throw error; }
    });
  }
  async launchInstall(plan) {
    if (!this.plans.has(plan) || this.busy) throw new Error("更新安装计划无效，请重新准备更新");
    this.busy = true;
    try {
      await validateBundle(plan.replacement, { platform: this.platform, arch: this.arch, version: plan.version, brand: plan.brand });
      await fs.writeFile(path.join(this.directory, "pending-install.json"), JSON.stringify(plan), { mode: 0o600 });
      const launched = await launchPreparedInstall(plan, { platform: this.platform });
      this.plans.delete(plan);
      this.change({ status: "installing", canInstall: false, error: null }); return launched;
    } catch (error) { await this.discardInstall(plan, error); this.change({ status: "error", error: errorMessage(error) }); throw error; }
    finally { this.busy = false; }
  }
  async discardInstall(plan, error) {
    if (!this.plans.has(plan)) return;
    this.plans.delete(plan);
    await fs.rm(plan.replacement, { recursive: true, force: true });
    await fs.rm(plan.jobDirectory, { recursive: true, force: true });
    this.change({ status: "ready", canInstall: Boolean(this.extracted && this.isPackaged), error: error ? errorMessage(error) : null });
  }
  async acknowledgeInstall() {
    // Call only after this version has successfully loaded its application UI.
    let plan;
    try { plan = JSON.parse(await fs.readFile(path.join(this.directory, "pending-install.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return false; return false; }
    if (typeof plan.id !== "string" || !/^[a-f0-9-]{36}$/.test(plan.id) || plan.jobDirectory !== path.join(this.directory, "install-" + plan.id) || plan.health !== path.join(plan.jobDirectory, "healthy") || plan.result !== path.join(plan.jobDirectory, "result.txt")) return false;
    let result = null; try { result = await fs.readFile(plan.result, "utf8"); } catch {}
    if (["installed", "rolled-back", "rollback-failed", "exit-timeout", "rename-failed", "invalid-path"].includes(result)) this.change({ installerResult: result });
    if (plan.version !== this.currentVersion || typeof plan.target !== "string" || typeof plan.executable !== "string" || path.resolve(plan.target, plan.executable) !== this.execPath) return false;
    if (result !== "waiting") return result === "installed";
    await fs.writeFile(plan.health, this.currentVersion, { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    this.change({ installerResult: "installed" }); return true;
  }
}
