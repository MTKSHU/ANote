import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export function createWorkspaceSync({
  serverURL,
  id,
  directory,
  token,
  operationId,
}) {
  const url = new URL(serverURL),
    dir = path.resolve(directory);
  if (!/^[-\w]{1,80}$/.test(id) || !token)
    throw new Error("缺少文档 ID 或会话令牌");
  const metaDir = path.join(dir, ".anote"),
    stateFile = path.join(metaDir, id + ".base.json");
  const digest = (input) => createHash("sha256").update(input).digest("hex");
  const exists = async (file) => !!(await fs.stat(file).catch(() => null));
  async function fileHash(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  }
  async function downloadAsset(asset, oldAssets = []) {
    const target = path.resolve(dir, asset.path);
    await safePath(target);
    const assetURL = new URL(asset.url, url);
    if (assetURL.origin !== url.origin) throw new Error("附件必须来自当前服务");
    if (!/^[a-f0-9]{64}$/.test(asset.hash)) throw new Error("附件校验值无效");
    let initialHash = null;
    if (await exists(target)) {
      const current = await fileHash(target);
      if (current === asset.hash) return;
      const previous = oldAssets.find((item) => item.path === asset.path);
      if (!previous || current !== previous.hash)
        throw new Error(`受保护附件发生变化，已保留：${asset.path}`);
      initialHash = current;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const partial = target + ".anote-partial-" + asset.hash;
    await safePath(partial);
    let offset = (await fs.stat(partial).catch(() => ({ size: 0 }))).size;
    if (asset.bytes !== undefined && offset > asset.bytes) {
      await fs.rm(partial, { force: true });
      offset = 0;
    }
    if (!(asset.bytes > 0 && offset === asset.bytes)) {
      while (true) {
        const response = await fetch(assetURL, {
          signal: AbortSignal.timeout(120000),
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${offset}-${offset + 16 * 1024 ** 2 - 1}`,
          },
        });
        if (!response.ok || !response.body) throw new Error("附件下载失败");
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("content-range") || "",
        );
        if (response.status === 206 && (!range || Number(range[1]) !== offset))
          throw new Error("附件续传位置不匹配");
        if (response.status !== 206 && offset) {
          await fs.truncate(partial, 0);
          offset = 0;
        }
        await pipeline(
          Readable.fromWeb(response.body),
          createWriteStream(partial, {
            flags: offset ? "a" : "w",
            mode: 0o600,
          }),
        );
        offset = (await fs.stat(partial)).size;
        if (!range || offset === Number(range[3])) break;
        if (offset !== Number(range[2]) + 1 || offset > Number(range[3]))
          throw new Error("附件续传大小异常");
      }
    }
    if ((await fileHash(partial)) !== asset.hash) {
      await fs.rm(partial, { force: true });
      throw new Error("附件校验失败");
    }
    const handle = await fs.open(partial, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await safePath(target);
    if (await exists(target)) {
      if ((await fileHash(target)) !== initialHash)
        throw new Error(`下载期间附件发生修改，已保留：${asset.path}`);
      const retained = path.join(
        metaDir,
        "conflicts",
        "asset-" + randomUUID() + path.extname(target),
      );
      await safePath(retained);
      await fs.mkdir(path.dirname(retained), { recursive: true });
      await fs.rename(target, retained);
    }
    await fs.rename(partial, target);
  }
  async function safePath(file) {
    if (file !== dir && !file.startsWith(dir + path.sep))
      throw new Error("同步路径超出工作目录");
    let current = file;
    while (current === dir || current.startsWith(dir + path.sep)) {
      const stat = await fs.lstat(current).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error("同步路径不能包含符号链接");
      if (current === dir) break;
      current = path.dirname(current);
    }
  }
  const readState = async () => {
    await safePath(stateFile);
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  };
  async function atomic(file, content) {
    await safePath(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".anote-partial-" + randomUUID();
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  }
  async function request(endpoint, method = "GET", body) {
    const response = await fetch(new URL(endpoint, url), {
      signal: AbortSignal.timeout(10000),
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(data.error || "同步请求失败"), {
        status: response.status,
        data,
      });
    return data;
  }
  async function localFile() {
    await safePath(dir);
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".md"));
    const matches = [];
    for (const name of files) {
      const file = path.join(dir, name),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error("验证同步目录不接受符号链接");
      const text = await fs.readFile(file, "utf8");
      if (text.startsWith(`---\nanote_doc: ${id}\n`)) matches.push(file);
    }
    if (matches.length > 1)
      throw new Error("同一文档出现多个本地副本，请先解决冲突");
    return matches[0] || path.join(dir, "研究笔记.md");
  }
  async function pull(expectedHash) {
    const file = await localFile(),
      old = await readState().catch(() => null);
    if (await exists(file)) {
      const localHash = digest(await fs.readFile(file));
      if (expectedHash && localHash !== expectedHash)
        throw new Error("同步期间本地文件再次修改，已保留，请重新同步");
      if (!expectedHash && (!old || old.fileHash !== localHash))
        throw new Error("本地有未同步修改，拒绝覆盖；请先 push 或 sync");
    }
    const data = await request(`/api/documents/${id}/export`);
    for (const asset of data.assets) await downloadAsset(asset, old?.assets);
    // Recheck before replacing Markdown, because downloading assets may take time.
    if (await exists(file)) {
      const current = digest(await fs.readFile(file));
      if (current !== (expectedHash || old?.fileHash))
        throw new Error("下载期间本地文件发生修改，已保留");
    }
    await atomic(file, data.markdown);
    await atomic(
      stateFile,
      JSON.stringify(
        {
          ...data.sidecar,
          assets: data.assets,
          file: path.basename(file),
          fileHash: digest(data.markdown),
        },
        null,
        2,
      ) + "\n",
    );
    return { direction: "pull", docId: id, file, hash: data.hash };
  }
  async function push() {
    const state = await readState().catch(() => {
        throw new Error("同步元数据缺失，请保留本地文件并恢复基准，不进行覆盖");
      }),
      file = await localFile();
    if (!(await exists(file)))
      throw new Error("本地文件缺失，未传播删除；请明确确认删除意图");
    const first = await fs.stat(file),
      markdown = await fs.readFile(file, "utf8"),
      second = await fs.stat(file);
    if (first.mtimeMs !== second.mtimeMs || first.size !== second.size)
      throw new Error("本地文件仍在写入，稍后重试");
    for (const asset of state.assets || []) {
      const assetPath = path.resolve(dir, asset.path);
      await safePath(assetPath);
      const hash = await fileHash(assetPath).catch(() => {
        throw new Error(`附件未到齐：${asset.path}`);
      });
      if (hash !== asset.hash)
        throw new Error(`受保护附件发生变化：${asset.path}`);
    }
    try {
      const result = await request(`/api/documents/${id}/import`, "POST", {
        markdown,
        opId: operationId ? await operationId(markdown) : randomUUID(),
      });
      const refreshed = await pull(digest(markdown));
      return {
        direction: "push",
        changed: result.changed,
        docId: id,
        file: refreshed.file,
      };
    } catch (e) {
      if (e.status === 409) {
        await fs.mkdir(path.join(metaDir, "conflicts"), { recursive: true });
        await atomic(
          path.join(metaDir, "conflicts", Date.now() + ".json"),
          JSON.stringify({ markdown, result: e.data }, null, 2),
        );
      }
      throw e;
    }
  }
  async function sync() {
    const state = await readState().catch(() => null);
    if (!state) return pull();
    const file = await localFile();
    if (!(await exists(file))) throw new Error("本地文件缺失，未传播删除");
    if (digest(await fs.readFile(file)) !== state.fileHash) return push();
    const remote = await request(`/api/documents/${id}`);
    if (
      digest(
        JSON.stringify(remote.snapshot, (_k, v) =>
          v && typeof v === "object" && !Array.isArray(v)
            ? Object.fromEntries(
                Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
              )
            : v,
        ),
      ) !== state.hash
    )
      return pull();
    return { direction: "unchanged", docId: id, file };
  }
  async function acceptRemote() {
    const file = await localFile();
    const markdown = await fs.readFile(file, "utf8");
    const backup = path.join(
      metaDir,
      "conflicts",
      "retained-" + Date.now() + "-" + randomUUID() + ".md",
    );
    await atomic(backup, markdown);
    const result = await pull(digest(markdown));
    return { ...result, backup };
  }
  return { pull, push, sync, acceptRemote };
}
