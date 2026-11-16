import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const stat = file => fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
export async function assertStorageDirectory(session) {
  if (!session.settings.dataDirectory) return;
  const root = session.dataRoot;
  const info = await stat(root);
  if (!info?.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== path.resolve(root))
    throw new Error("工作目录不可用，请重新连接磁盘后点击“重新检查目录”；原目录设置已保留");
  let marker;
  try {
    const file = path.join(root, ".anote-storage.json"), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid marker");
    marker = JSON.parse(await fs.readFile(file, "utf8"));
  }
  catch { throw new Error("工作目录标记缺失或损坏，未创建空笔记库，请检查原目录"); }
  if (marker.profileKey !== session.profileKey || marker.serverURL !== session.settings.serverURL || marker.userId !== session.settings.user?.id)
    throw new Error("工作目录不属于当前账号或服务器，未读取或覆盖原文件");
}
export async function assertPersonalDirectory(directory) {
  let found = false;
  for (const name of [".anote", ".simple-notes"]) {
    const root = path.join(directory, name), info = await stat(root);
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("个人工作目录不能包含符号链接或特殊文件");
    const file = path.join(root, "catalog.json"), entry = await stat(file);
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("个人工作目录的知识库清单无效");
    let catalog;
    try { catalog = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error("个人工作目录的知识库清单损坏，原文件已保留"); }
    if (catalog.format !== "simple-notes-personal" || ![1,2].includes(catalog.version) || typeof catalog.id !== "string" || !/^[a-f0-9-]{36}$/i.test(catalog.id))
      throw new Error("个人工作目录的知识库清单无效，原文件已保留");
    found = true;
  }
  if (!found) throw new Error("个人工作目录不可用，请重新连接磁盘后点击“重新检查目录”，或选择原有笔记目录；未创建空笔记库");
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(root, skip = []) {
  const result = [];
  async function walk(relative = "") {
    const file = path.join(root, relative), info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile())
      throw new Error("工作目录包含符号链接或特殊文件，原目录已保留：" + relative);
    if (info.isDirectory()) {
      result.push({ path: relative, directory: true });
      for (const name of (await fs.readdir(file)).sort()) {
        const next = relative ? relative + "/" + name : name;
        if (!skip.includes(next)) await walk(next);
      }
    } else result.push({ path: relative, bytes: info.size, hash: await digest(file) });
  }
  await walk();
  return result;
}
async function copyTree(source, destination, skip = []) {
  const before = await inventory(source, skip);
  for (const entry of before) {
    const from = path.join(source, entry.path), to = path.join(destination, entry.path);
    if (entry.directory) await fs.mkdir(to, { mode: 0o700 });
    else {
      const info = await fs.lstat(from);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("迁移期间源文件发生变化，原目录已保留");
      await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      await fs.chmod(to, 0o600);
      if (await digest(to) !== entry.hash) throw new Error("迁移文件校验失败，原目录已保留：" + entry.path);
    }
  }
  if (JSON.stringify(await inventory(source, skip)) !== JSON.stringify(before))
    throw new Error("迁移期间源目录发生变化，请停止其他编辑后重试；原目录已保留");
  return before;
}

/** Copy and verify before changing the durable pointer. Keep the source copy
 * for recovery, including when the process exits before committing the pointer. */
export async function migrateStorageTree({ source, destination, skip = [], extraSources = [], commit, afterCopy }) {
  source = await fs.realpath(source);
  const parent = await fs.realpath(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  if (within(source, destination) || within(destination, source))
    throw new Error("新旧工作目录不能相同或互相包含，请选择独立目录");
  if (await stat(destination)) throw new Error("目标已有 ANote 数据，未合并或覆盖；请选择其他目录");
  const stage = path.join(parent, ".anote-storage-migration-" + randomUUID());
  let promoted = false, committed = false;
  try {
    await copyTree(source, stage, skip);
    for (const extra of extraSources) {
      const target = path.resolve(stage, extra.relative);
      if (!within(stage, target) || target === stage) throw new Error("迁移附加目录无效");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyTree(await fs.realpath(extra.source), target, extra.skip || []);
    }
    await afterCopy?.(stage);
    if (await stat(destination)) throw new Error("目标目录已被占用，原目录已保留");
    await fs.rename(stage, destination); promoted = true;
    await commit(destination); committed = true;
    return { directory: destination, previousDirectory: source };
  } finally {
    if (!committed) await fs.rm(promoted ? destination : stage, { recursive: true, force: true });
  }
}
