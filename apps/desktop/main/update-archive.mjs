import { updateFS as fs, updateReadStream as createReadStream, updateWriteStream as createWriteStream } from "./update-fs.mjs";
import path from "node:path";
import { createGunzip, createInflateRaw } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 50000;
const fail = (message) => { throw new Error("更新包无效：" + message); };

export function archiveName(value, root, windows = false) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x1f\x7f:]/.test(value)) fail("非法路径");
  const name = value.replace(/^\.\//, "").replace(/\/$/, "");
  const parts = name.split("/");
  if (parts[0] !== root || parts.some((p) => !p || p === "." || p === "..")) fail("路径超出应用目录");
  if (windows && parts.some((p) => /[<>"|?*]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail("非法 Windows 路径");
  return name;
}

class Bytes {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.buffer = Buffer.alloc(0); this.total = 0; }
  async read(size, optional = false) {
    while (this.buffer.length < size) {
      const item = await this.iterator.next();
      if (item.done) { if (optional && !this.buffer.length) return null; fail("文件被截断"); }
      this.total += item.value.length;
      if (this.total > MAX_BYTES) fail("解压后体积过大");
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, item.value]) : item.value;
    }
    const result = this.buffer.subarray(0, size); this.buffer = this.buffer.subarray(size); return result;
  }
}

function octal(buffer) {
  const value = buffer.toString("ascii").replace(/\0.*$/, "").trim();
  if (value && !/^[0-7]+$/.test(value)) fail("不支持的 tar 数字");
  const result = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_BYTES) fail("非法大小");
  return result;
}
const cstring = (value) => value.toString("utf8").replace(/\0.*$/, "");
function paxFields(buffer) {
  const result = Object.create(null);
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(32, offset);
    if (space < offset || space - offset > 8) fail("非法 PAX 记录");
    const length = Number(buffer.subarray(offset, space).toString());
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > buffer.length || buffer[offset + length - 1] !== 10) fail("非法 PAX 长度");
    const line = buffer.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = line.indexOf("=");
    if (equal < 1) fail("非法 PAX 字段");
    result[line.slice(0, equal)] = line.slice(equal + 1); offset += length;
  }
  return result;
}

async function extractTar(archive, directory, root) {
  const source = createReadStream(archive), input = createGunzip();
  source.on("error", (error) => input.destroy(error)); source.pipe(input);
  const reader = new Bytes(input), names = new Set(), links = [];
  let pax = {}, longName, longLink, entries = 0, outputBytes = 0;
  try {
    while (true) {
      const header = await reader.read(512, true);
      if (!header) fail("缺少 tar 结束标记");
      if (header.every((byte) => byte === 0)) {
        let tail;
        while ((tail = await reader.read(512, true))) if (!tail.every((byte) => byte === 0)) fail("tar 结束后的异常内容");
        break;
      }
      if (++entries > MAX_ENTRIES) fail("文件数量过多");
      const checksum = octal(header.subarray(148, 156));
      let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== sum) fail("tar 头校验失败");
      const size = octal(header.subarray(124, 136));
      const type = String.fromCharCode(header[156] || 48);
      if (["x", "g", "L", "K"].includes(type)) {
        if (size > 1024 * 1024) fail("元数据过大");
        const data = await reader.read(size);
        if (type === "x") pax = paxFields(data);
        else if (type === "g") {
          const fields = paxFields(data);
          if (fields.path || fields.linkpath || fields.size || Object.keys(fields).some((k) => k.startsWith("GNU.sparse"))) fail("不支持的全局 PAX 字段");
        } else if (type === "L") longName = cstring(data); else longLink = cstring(data);
        if (size % 512) await reader.read(512 - size % 512);
        continue;
      }
      if (pax.size !== undefined && Number(pax.size) !== size || Object.keys(pax).some((k) => k.startsWith("GNU.sparse"))) fail("不支持的 tar 扩展");
      const prefix = cstring(header.subarray(345, 500));
      const name = archiveName(pax.path || longName || (prefix ? prefix + "/" : "") + cstring(header.subarray(0, 100)), root);
      const target = path.join(directory, name);
      const link = pax.linkpath || longLink || cstring(header.subarray(157, 257));
      pax = {}; longName = undefined; longLink = undefined;
      if (names.has(name)) fail("重复路径");
      names.add(name); outputBytes += size;
      if (outputBytes > MAX_BYTES) fail("解压后体积过大");
      if (type === "5") {
        if (size) fail("目录包含数据");
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
      } else if (type === "2") {
        if (size || !link || /[\\\x00-\x1f\x7f:]/.test(link) || path.posix.isAbsolute(link)) fail("非法符号链接");
        archiveName(path.posix.normalize(path.posix.join(path.posix.dirname(name), link)), root);
        links.push({ target, link });
      } else if (type === "0") {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const file = await fs.open(target, "wx", octal(header.subarray(100, 108)) & 0o111 ? 0o755 : 0o644);
        try { for (let remaining = size; remaining > 0;) { const data = await reader.read(Math.min(remaining, 65536)); await file.writeFile(data); remaining -= data.length; } }
        finally { await file.close(); }
      } else fail("不支持的 tar 文件类型");
      if (size % 512) await reader.read(512 - size % 512);
    }
    // Links are created last: no archive entry can write through a symlink.
    for (const { target, link } of links) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.symlink(link, target); }
    for (const { target } of links) {
      const real = await fs.realpath(target);
      if (!real.startsWith(path.join(directory, root) + path.sep)) fail("符号链接超出应用目录");
    }
  } finally { source.destroy(); input.destroy(); }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let n = value; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0;
});
async function readAt(file, size, position) {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) fail("文件被截断"); offset += bytesRead;
  }
  return buffer;
}
async function extractZip(archive, directory, root) {
  const file = await fs.open(archive, "r");
  try {
    const { size } = await file.stat();
    const tail = await readAt(file, Math.min(size, 65557), Math.max(0, size - 65557));
    let index = tail.length - 22;
    for (; index >= 0; index--) if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) break;
    if (index < 0) fail("缺少 zip 目录");
    const count = tail.readUInt16LE(index + 10), cdSize = tail.readUInt32LE(index + 12), cdOffset = tail.readUInt32LE(index + 16);
    if (tail.readUInt16LE(index + 4) || tail.readUInt16LE(index + 6) || tail.readUInt16LE(index + 8) !== count || !count || count > MAX_ENTRIES || cdSize > 32 * 1024 ** 2 || cdOffset + cdSize !== size - tail.length + index) fail("不支持的 zip 布局");
    const central = await readAt(file, cdSize, cdOffset), entries = [], names = new Set();
    let offset = 0, total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) fail("非法 zip 目录");
      const flags = central.readUInt16LE(offset + 8), method = central.readUInt16LE(offset + 10), crc = central.readUInt32LE(offset + 16), compressed = central.readUInt32LE(offset + 20), bytes = central.readUInt32LE(offset + 24);
      const nameSize = central.readUInt16LE(offset + 28), extra = central.readUInt16LE(offset + 30), comment = central.readUInt16LE(offset + 32), mode = central.readUInt32LE(offset + 38) >>> 16, position = central.readUInt32LE(offset + 42);
      if (flags & ~0x808 || ![0, 8].includes(method) || bytes > MAX_BYTES || compressed === 0xffffffff || position === 0xffffffff || position + compressed > cdOffset || offset + 46 + nameSize + extra + comment > central.length || central.readUInt16LE(offset + 34)) fail("不支持的 zip 条目");
      const rawName = central.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
      const name = archiveName(rawName, root, true), isDirectory = rawName.endsWith("/");
      if (mode & 0xf000 && (mode & 0xf000) !== (isDirectory ? 0x4000 : 0x8000)) fail("不支持的 zip 文件类型");
      if (names.has(name.toLowerCase())) fail("重复路径"); names.add(name.toLowerCase());
      total += bytes; if (total > MAX_BYTES || isDirectory && bytes) fail("解压后体积异常");
      entries.push({ name, rawName, flags, method, crc, compressed, bytes, position, isDirectory });
      offset += 46 + nameSize + extra + comment;
    }
    if (offset !== central.length) fail("zip 目录长度异常");
    const positions = entries.map((entry) => entry.position).sort((a, b) => a - b);
    if (new Set(positions).size !== positions.length) fail("zip 本地条目重叠");
    const boundaries = new Map(positions.map((position, i) => [position, positions[i + 1] ?? cdOffset]));
    for (const entry of entries) {
      const local = await readAt(file, 30, entry.position);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) fail("zip 本地头不匹配");
      const nameSize = local.readUInt16LE(26), dataOffset = entry.position + 30 + nameSize + local.readUInt16LE(28);
      if (dataOffset + entry.compressed > boundaries.get(entry.position) || (await readAt(file, nameSize, entry.position + 30)).toString("utf8") !== entry.rawName) fail("zip 路径或条目边界不匹配");
      const target = path.join(directory, entry.name);
      if (entry.isDirectory) { await fs.mkdir(target, { recursive: true, mode: 0o700 }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (!entry.compressed && !entry.bytes) { if (entry.crc) fail("zip CRC 错误"); await fs.writeFile(target, "", { flag: "wx", mode: 0o644 }); continue; }
      let written = 0, crc = 0xffffffff;
      const check = new Transform({ transform(chunk, _, callback) {
        written += chunk.length;
        if (written > entry.bytes) return callback(new Error("更新包解压大小超出清单"));
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
        callback(null, chunk);
      } });
      const source = createReadStream(archive, { start: dataOffset, end: dataOffset + entry.compressed - 1 });
      const streams = entry.method === 8 ? [source, createInflateRaw(), check] : [source, check];
      await pipeline(...streams, createWriteStream(target, { flags: "wx", mode: 0o644 }));
      if (written !== entry.bytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail("zip 完整性校验失败");
    }
  } finally { await file.close(); }
}

async function asarPackage(archive) {
  const file = await fs.open(archive, "r");
  try {
    const size = (await file.stat()).size, prefix = await readAt(file, 8, 0);
    const length = prefix.readUInt32LE(4);
    if (prefix.readUInt32LE(0) !== 4 || length < 8 || length > 32 * 1024 ** 2 || length + 8 > size) fail("ASAR 头无效");
    const header = await readAt(file, length, 8), jsonLength = header.readUInt32LE(4);
    if (jsonLength > length - 8) fail("ASAR 索引无效");
    const entries = JSON.parse(header.subarray(8, 8 + jsonLength).toString("utf8")).files;
    const pkg = entries?.["package.json"];
    if (!pkg || pkg.unpacked || !/^\d+$/.test(pkg.offset) || !Number.isSafeInteger(pkg.size) || pkg.size < 2 || pkg.size > 65536 || !entries?.dist?.files?.["main.cjs"]) fail("缺少客户端入口");
    const offset = 8 + length + Number(pkg.offset);
    if (!Number.isSafeInteger(offset) || offset + pkg.size > size) fail("ASAR 内容超出文件");
    return JSON.parse((await readAt(file, pkg.size, offset)).toString("utf8"));
  } finally { await file.close(); }
}

export async function validateBundle(bundle, { platform, arch, version, brand }) {
  const bundleStat = await fs.lstat(bundle);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink()) fail("应用根目录无效");
  const base = await fs.realpath(bundle);
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const real = await fs.realpath(filename);
        if (real !== base && !real.startsWith(base + path.sep)) fail("符号链接超出应用本体");
      } else if (entry.isDirectory()) await walk(filename);
      else if (!entry.isFile()) fail("应用包含特殊文件");
    }
  }
  await walk(bundle);
  const resources = platform === "darwin" ? "Contents/Resources" : "resources";
  const pkg = await asarPackage(path.join(bundle, resources, "app.asar"));
  if (pkg.name !== "anote-desktop" || !["ANote", "SimpleNote"].includes(pkg.productName) || brand !== undefined && pkg.productName !== brand || pkg.version !== version) fail("包内客户端版本或产品标识不匹配");
  const executable = platform === "darwin" ? `Contents/MacOS/${pkg.productName}` : pkg.productName + (platform === "win32" ? ".exe" : "");
  const exePath = path.join(bundle, executable);
  const stat = await fs.lstat(exePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("缺少客户端程序");
  const file = await fs.open(exePath, "r"); let header;
  try { header = await readAt(file, Math.min(stat.size, 4096), 0); } finally { await file.close(); }
  if (header.length < 64) fail("客户端程序被截断");
  if (platform === "linux" && !(header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === (arch === "x64" ? 62 : 183))) fail("Linux 程序架构不匹配");
  if (platform === "win32") {
    const offset = header.readUInt32LE(60);
    if (header.toString("ascii", 0, 2) !== "MZ" || offset + 6 > header.length || header.readUInt32LE(offset) !== 0x4550 || header.readUInt16LE(offset + 4) !== 0x8664) fail("Windows 程序架构不匹配");
  }
  if (platform === "darwin" && !(header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === (arch === "x64" ? 0x01000007 : 0x0100000c))) fail("macOS 程序架构不匹配");
  if (platform !== "win32" && !(stat.mode & 0o111)) fail("客户端程序没有执行权限");
  return { executable, version: pkg.version, brand: pkg.productName };
}

export async function extractUpdate(archive, directory, release) {
  const brand = release.brand || (release.file?.startsWith("ANote-") ? "ANote" : "SimpleNote");
  if (!["ANote", "SimpleNote"].includes(brand)) fail("产品标识无效");
  const root = `${brand}-${release.platform}-${release.arch}`;
  await fs.mkdir(directory, { recursive: false, mode: 0o700 });
  try {
    if (release.platform === "win32") await extractZip(archive, directory, root);
    else await extractTar(archive, directory, root);
    const bundle = path.join(directory, root, ...(release.platform === "darwin" ? [brand + ".app"] : []));
    const checked = await validateBundle(bundle, { ...release, brand });
    return { bundle, ...checked };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
