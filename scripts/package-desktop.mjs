import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packager } from "@electron/packager";
const execute = promisify(execFile),
  root = process.cwd(),
  stage = path.join(root, ".work/desktop-package"),
  out = path.join(root, "artifacts/releases");
async function shaFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const pkg = JSON.parse(await fs.readFile("apps/desktop/package.json", "utf8")),
  electron = JSON.parse(
    await fs.readFile("node_modules/electron/package.json", "utf8"),
  ).version;
// The pinned Electron npm package ships the release checksums. Validate cached
// runtimes with these hashes instead of fetching SHASUMS256.txt on every build.
const electronChecksums = JSON.parse(
  await fs.readFile("node_modules/electron/checksums.json", "utf8"),
);
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
await fs.mkdir(out, { recursive: true });
await fs.cp("apps/desktop/dist", path.join(stage, "dist"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map"),
});
await fs.writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
for (const file of ["LICENSE", "NOTICE"])
  await fs.copyFile(file, path.join(stage, file));
await fs.writeFile(
  path.join(stage, "README.txt"),
  "ANote 桌面预览版\n\n本地个人模式：选择自己的目录，无需账号和服务器。正文、附件、历史及 Markdown 保存在该目录中。团队连接不会自动上传个人笔记。\n\n团队连接：填写你部署的平台地址，使用自己的账号登录。保留 .anote 同步元数据，每个账号和服务使用独立目录。\n\n本构建未经签名。Windows 与 macOS 需要在对应系统验证；macOS 未完成签名或公证。\n",
);
// Include notices for the project's production dependency tree; the desktop uses a subset.
const seen = new Set(),
  notices = [];
async function collect(name, base = root) {
  let current = base,
    folder;
  while (true) {
    const candidate = path.join(current, "node_modules", name);
    if (
      await fs.stat(path.join(candidate, "package.json")).catch(() => false)
    ) {
      folder = await fs.realpath(candidate);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  if (seen.has(folder)) return;
  seen.add(folder);
  const value = JSON.parse(
    await fs.readFile(path.join(folder, "package.json"), "utf8"),
  );
  if (!name.startsWith("@anote/")) {
    notices.push(
      "\n\n===== " +
        value.name +
        " " +
        value.version +
        " (" +
        (value.license || "see package notice") +
        ") =====\n",
    );
    for (const file of await fs.readdir(folder))
      if (/^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-].*)?$/i.test(file)) {
        const target = path.join(folder, file),
          stat = await fs.stat(target);
        if (stat.isFile() && stat.size < 512000)
          notices.push(await fs.readFile(target, "utf8"));
      }
  }
  for (const dependency of Object.keys(value.dependencies || {}))
    await collect(dependency, folder);
}
for (const dependency of Object.keys(
  JSON.parse(await fs.readFile("package.json", "utf8")).dependencies || {},
))
  await collect(dependency);
await collect("@anote/editor");
await fs.writeFile(
  path.join(stage, "THIRD_PARTY_NOTICES.txt"),
  "Project production dependency notices (desktop uses a subset). Electron/Chromium notices are shipped beside the executable.\n" +
    notices.join("\n"),
);
const targets = process.env.DESKTOP_TARGETS
  ? process.env.DESKTOP_TARGETS.split(",").map((value) => {
      const parts = value.split("-");
      return [parts[0], parts[1]];
    })
  : [
      ["linux", "x64"],
      ["win32", "x64"],
      ["darwin", "x64"],
      ["darwin", "arm64"],
    ];
const buildFiles = [];
async function scan(directory) {
  for (const entry of (
    await fs.readdir(directory, { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else buildFiles.push([path.relative(stage, file), await shaFile(file)]);
  }
}
await scan(stage);
const buildHash = createHash("sha256")
    .update(JSON.stringify(buildFiles))
    .digest("hex"),
  previous = await fs
    .readFile(path.join(out, "manifest.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
const manifest = {
  applicationName: pkg.productName,
  version: pkg.version,
  electron,
  buildHash,
  builtIn: "Docker Linux",
  createdAt: new Date().toISOString(),
  signed: false,
  nativeAcceptance: {
    linux: "Docker Electron only",
    win32: "pending",
    darwin: "pending",
  },
  packages: previous?.buildHash === buildHash ? previous.packages : [],
};
for (const [platform, arch] of targets) {
  if (
    !["linux", "win32", "darwin"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error("Unsupported target");
  const existing = manifest.packages.find(
    (value) => value.platform === platform && value.arch === arch,
  );
  if (
    existing &&
    (await shaFile(path.join(out, existing.file)).catch(() => null)) ===
      existing.sha256
  ) {
    console.log("Reusing " + existing.file);
    continue;
  }
  console.log("Packaging " + platform + " " + arch);
  const runtimeFile = `electron-v${electron}-${platform}-${arch}.zip`;
  if (!/^[a-f0-9]{64}$/.test(electronChecksums[runtimeFile] || ""))
    throw new Error("Missing pinned Electron checksum for " + runtimeFile);
  let directory;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      [directory] = await packager({
        dir: stage,
        out,
        name: pkg.productName,
        executableName: pkg.productName,
        appBundleId: "org.anote.desktop",
        appVersion: pkg.version,
        electronVersion: electron,
        platform,
        arch,
        overwrite: true,
        prune: false,
        asar: true,
        asarIntegrityDigest: false,
        download: {
          cacheRoot: "/root/.cache/electron",
          checksums: { [runtimeFile]: electronChecksums[runtimeFile] },
        },
        osxSign: false,
        osxNotarize: false,
      });
      break;
    } catch (error) {
      if (
        attempt === 2 ||
        !/(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|socket hang up)/.test(
          String(error) + String(error?.code) + String(error?.cause?.code),
        )
      )
        throw error;
      console.log("Retrying Electron download for " + platform + " " + arch);
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
  const filename = `${pkg.productName}-${pkg.version}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`,
    archive = path.join(out, filename);
  if (platform === "win32")
    await execute(
      "python3",
      [
        "-c",
        `import os,sys,zipfile
source,target=sys.argv[1:]
with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
 for directory,dirs,files in os.walk(source):
  for name in files:
   file=os.path.join(directory,name);archive.write(file,os.path.relpath(file,os.path.dirname(source)))
`,
        directory,
        archive,
      ],
      { maxBuffer: 1024 ** 2 },
    );
  else
    await execute(
      "tar",
      ["-czf", archive, "-C", out, path.basename(directory)],
      { maxBuffer: 1024 ** 2 },
    );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  manifest.packages = manifest.packages.filter(
    (value) => value.platform !== platform || value.arch !== arch,
  );
  manifest.packages.push({
    platform,
    arch,
    file: filename,
    bytes: (await fs.stat(archive)).size,
    sha256: hash.digest("hex"),
    directory: path.relative(root, directory),
  });
  await fs.writeFile(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log("Built " + filename);
}
await fs.writeFile(
  path.join(out, "SHA256SUMS"),
  manifest.packages
    .map((value) => value.sha256 + "  " + value.file)
    .join("\n") + "\n",
);
console.log(
  JSON.stringify({
    version: pkg.version,
    packages: manifest.packages.map((value) => ({
      platform: value.platform,
      arch: value.arch,
      file: value.file,
      bytes: value.bytes,
    })),
  }),
);
