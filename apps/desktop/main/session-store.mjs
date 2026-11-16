import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temp, file);
}
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
export function serverOrigin(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("请输入服务地址，例如 https://lab.example.org");
  return url.origin;
}
const defaults = () => ({
  serverURL: "",
  user: null,
  offline: false,
  workspace: "",
  documents: [],
  lastDoc: null,
});
export class SessionStore {
  constructor(root, safeStorage) {
    this.root = root;
    this.safeStorage = safeStorage;
    this.token = null;
    this.settings = defaults();
    this.saves = Promise.resolve();
  }
  get profileKey() {
    return createHash("sha256")
      .update(
        this.settings.serverURL +
          "|" +
          (this.settings.user?.id || "signed-out"),
      )
      .digest("hex");
  }
  get profileRoot() {
    return path.join(this.root, "profiles", this.profileKey);
  }
  get dataRoot() {
    return this.settings.dataDirectory || this.profileRoot;
  }
  async load() {
    this.settings = {
      ...defaults(),
      ...(await readJSON(path.join(this.root, "settings.json"), {})),
    };
    try {
      const encrypted = await fs.readFile(path.join(this.root, "session.bin"));
      if (await this.canEncrypt()) {
        const decrypted = await this.safeStorage.decryptStringAsync(encrypted);
        if (typeof decrypted?.result !== "string" || !decrypted.result || /[\r\n]/.test(decrypted.result))
          throw new Error("登录凭据无效");
        this.token = decrypted.result;
        if (decrypted.shouldReEncrypt) {
          // Rotation is best effort: a valid in-memory session must survive a
          // temporarily unavailable key provider, keeping the previous file.
          await this.saveCredential(this.token).catch(() => {
            this.credentialWarning = "系统凭据存储暂不可用，本次登录已恢复";
          });
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        this.credentialWarning = "系统凭据存储暂不可用，请重新登录";
    }
    if (this.settings.user && !this.token) {
      this.settings.offline = true;
      this.credentialWarning = "会话未保存，请重新登录后同步";
    }
    return this;
  }
  async canEncrypt() {
    const available = this.safeStorage.isAsyncEncryptionAvailable
      ? await this.safeStorage.isAsyncEncryptionAvailable()
      : false;
    if (
      process.platform === "linux" &&
      this.safeStorage.getSelectedStorageBackend?.() === "basic_text"
    )
      return false;
    return available;
  }
  async saveCredential(token) {
    const encrypted = await this.safeStorage.encryptStringAsync(token);
    const file = path.join(this.root, "session.bin");
    const temp = file + "." + randomUUID() + ".tmp";
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temp, encrypted, { mode: 0o600, flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async save() {
    const settings = structuredClone(this.settings),
      profile = this.profileRoot;
    this.saves = this.saves
      .catch(() => {})
      .then(async () => {
        if (settings.user)
          await atomicJSON(path.join(profile, "settings.json"), settings);
        await atomicJSON(path.join(this.root, "settings.json"), settings);
      });
    await this.saves;
  }
  async connect(
    { serverURL, username, password },
    beforeSwitch = async () => {},
  ) {
    const origin = serverOrigin(serverURL),
      health = await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(8000),
      }).then((r) => r.json());
    const isLab = health.mode === "validation-only",
      response = await fetch(
        origin + (isLab ? "/api/session" : "/api/auth/login"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isLab
              ? { user: username, secret: password }
              : { username, password },
          ),
          signal: AbortSignal.timeout(8000),
        },
      ),
      result = await response.json();
    if (!response.ok || !result.token || !result.user?.id)
      throw new Error(result.error || result.message || "登录失败");
    return this.acceptSession(origin, result, beforeSwitch, isLab);
  }
  async acceptSession(
    serverURL,
    result,
    beforeSwitch = async () => {},
    isLab = false,
  ) {
    const origin = serverOrigin(serverURL);
    if ((!isLab && !/^[\w-]{43}$/.test(result.token)) || !result.user?.id)
      throw new Error("登录响应无效");
    await beforeSwitch();
    await this.save();
    const same =
      this.settings.serverURL === origin &&
      this.settings.user?.id === result.user.id;
    const key = createHash("sha256")
      .update(origin + "|" + result.user.id)
      .digest("hex");
    const previous = same
      ? this.settings
      : await readJSON(
          path.join(this.root, "profiles", key, "settings.json"),
          {},
        );
    // A crash after saving the new profile but before encrypting its token
    // must never restore the previous account's credential beside it. Remove
    // the old credential before changing either in-memory identity or settings.
    // Failure to remove it aborts the switch with the previous identity intact.
    if (!same)
      await fs.unlink(path.join(this.root, "session.bin")).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
    this.token = result.token;
    this.settings = {
      ...defaults(),
      ...previous,
      serverURL: origin,
      user: result.user,
      offline: false,
      validationMode: isLab,
    };
    await this.save();
    try {
      if (await this.canEncrypt()) {
        await this.saveCredential(result.token);
        this.credentialWarning = "";
      } else {
        await fs.unlink(path.join(this.root, "session.bin")).catch(() => {});
        this.credentialWarning = "当前系统没有可用密钥库，本次会话不保存登录凭据";
      }
    } catch {
      // Never leave another account's old credential beside the new profile.
      await fs.unlink(path.join(this.root, "session.bin")).catch(() => {});
      this.credentialWarning = "系统凭据存储暂不可用，本次会话不保存登录凭据";
    }
    return this.state();
  }
  state() {
    return {
      ...this.settings,
      token: this.token,
      credentialWarning: this.credentialWarning || "",
    };
  }
  async logout() {
    await this.save();
    if (
      this.token &&
      this.settings.serverURL &&
      !this.settings.validationMode
    ) {
      await fetch(this.settings.serverURL + "/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + this.token },
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
    this.token = null;
    this.settings = defaults();
    await fs.unlink(path.join(this.root, "session.bin")).catch(() => {});
    await this.save();
  }
  async chooseWorkspace(directory) {
    const marker = path.join(directory, ".anote-workspace.json"),
      owner = await readJSON(marker, null);
    if (owner && owner.profile !== this.profileKey)
      throw new Error("此目录属于另一个账号或服务，请选择独立目录");
    if (this.settings.documents.length && this.settings.workspace !== directory)
      throw new Error("已有文档正在同步，请先完成工作目录迁移");
    await atomicJSON(marker, { profile: this.profileKey, format: 1 });
    this.settings.workspace = directory;
    await this.save();
    return directory;
  }
}
