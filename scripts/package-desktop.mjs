import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { packager } from "@electron/packager";
import { EDITOR_SCHEMA_VERSION } from "@anote/document-model";
const execute = promisify(execFile),
  root = process.cwd(),
  stage = path.resolve(root, process.env.ANOTE_DESKTOP_STAGE || ".work/desktop-package"),
  out = path.resolve(root, process.env.ANOTE_DESKTOP_OUTPUT || "artifacts/releases"),
  previewBuild = process.env.ANOTE_RELEASE_CHANNEL === "preview";
if (process.env.ANOTE_RELEASE_CHANNEL === "preview" && out === path.resolve(root, "artifacts/releases"))
  throw new Error("Preview packages require a separate ANOTE_DESKTOP_OUTPUT directory");
async function shaFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const pkg = JSON.parse(await fs.readFile("apps/desktop/package.json", "utf8")),
  serverURL = process.env.VITE_ANOTE_SERVER_URL || "",
  electron = JSON.parse(
    await fs.readFile("node_modules/electron/package.json", "utf8"),
  ).version;
if (pkg.productName !== "ANote") throw new Error("Canonical desktop productName must be ANote");
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
await fs.cp("apps/desktop/assets", path.join(stage, "assets"), {recursive:true});
await fs.writeFile(
  path.join(stage, "package.json"),
  JSON.stringify(pkg, null, 2) + "\n",
);
await fs.writeFile(
  path.join(stage, "README.txt"),
  `ANote 桌面预览版 ${pkg.version}\n\n本地个人模式：选择自己的目录，无需账号和服务器。正文、附件、历史及 Markdown 保存在该目录的 .anote 中，旧版 .simple-notes 目录会自动迁移；界面的“打开本地笔记目录”可打开 Markdown 文件夹。切换到团队连接不会自动上传个人笔记。\n\n团队连接：服务地址 ${serverURL || "由部署者提供，首次连接时填写"}，也可填写管理员提供的域名。使用团队成员账号登录，可选择本地工作目录同步团队笔记。不要删除 .anote 同步元数据或将同一同步目录交给其他账号。\n\n当前协作编辑格式为 ${EDITOR_SCHEMA_VERSION}，包含 360° 全景图片和视频；连接相同格式的服务端需使用兼容客户端，网页端刷新即可更新。360° 全景支持单目等距柱状投影，可环顾、缩放和全屏，视频编码需由当前环境支持。\n\n本次为未签名的内部预览构建。Linux 在 Docker 内运行验证；Windows 和 macOS 尚待原生验收。macOS 尚未进行 Developer ID 签名或公证。\n本地版本历史和冲突保留继续工作，服务器备份由部署者独立管理。\n`,
);
if (!previewBuild) {
  const readme = path.join(stage, "README.txt");
  await fs.writeFile(readme, (await fs.readFile(readme, "utf8"))
    .replace("ANote 桌面预览版", "ANote 桌面客户端")
    .replace("本次为未签名的内部预览构建。", "本次为未签名构建。"));
}
await fs.appendFile(path.join(stage,"README.txt"),
  "\n离线副本与独立备份：连接平台后，在“设置 → 离线与备份”开启“始终保留服务器笔记的本地副本”，默认自动保存全部有阅读权限的笔记、目录及附件，可在高级设置调整范围。切换服务器位于账号设置中，侧栏不再显示本地目录和模式开关。断网可编辑正文和标题，并在已下载的可写知识库中新建笔记，联网后自动尝试合并同步。新附件上传需要联网。可选择独立备份目录，自动备份默认每15分钟，恢复前保留当前副本。副本和备份均按服务器及账号隔离。\n\n客户端更新：在“设置 → 桌面客户端”检查更新。更新包通过大小、SHA-256和版本校验后，点击“保存并重启更新”安装。0.4.12及更早版本首次需手动升级；0.4.13可在线升级到本版兼容包，界面统一显示ANote，原程序路径暂时保留以兼容旧更新器和快捷方式；后续新版会转用ANote更新渠道。也可直接手动安装正常ANote包。个人数据、离线副本及设置会继续使用已有目录。\n");
for (const file of ["LICENSE", "NOTICE"]) await fs.copyFile(file, path.join(stage, file));
// Include notices for the project's production dependency tree; the desktop uses a subset.
await fs.appendFile(path.join(stage,"README.txt"),
  "\nSVG 图片可在笔记、只读分享和打印中显示，历史 SVG 附件无需重新插入。左上角固定为侧栏折叠与平台名称，收起侧栏后显示展开与首页；右上角固定为提醒与头像。点击头像可进入工作空间切换（二级菜单：本地模式、个人、团队列表）、好友管理、团队管理、检查更新、设置及退出登录。切换工作空间时先保存当前草稿；取消连接或目录选择会保留当前内容。\n");
await fs.appendFile(path.join(stage,"README.txt"),
  "\n团队置顶笔记以自适应卡片显示标题、摘要和知识库，公告另有标识。独立本地备份改为增量保存：未变化的笔记与附件复用已有内容，没有变化时不新增备份；完成提示显示新增空间。旧完整备份仍可恢复，过期时间点按保留数量清理，共用内容仅在不再被引用时回收。搬移备份时请复制完整账号备份目录。\n");
await fs.appendFile(path.join(stage,"README.txt"),
  "\n0.5.0 引入正文分块增量备份，小幅编辑只新增变化的分块；首次使用v3备份会建立正文分块基线，已有v3备份继续复用，旧版备份继续兼容。备份记录每页10条，可单独删除时间点，仍有其他备份引用的内容会保留。支持插入笔记链接和自动整理文末参考笔记；侧栏最多显示3个知识库、每库3篇笔记。\n");
await fs.appendFile(path.join(stage,"README.txt"),
  `\n${pkg.version}${previewBuild ? " 预览" : ""}：本地副本保存一次完整基线，后续只传增量，单篇历史合并与落盘由后台线程处理；独立备份、列表与删除也使用后台线程，关闭时仍等待已接收的保存任务。图片、视频与双图对比临近阅读位置才加载；音频仅显示播放控件，悬停查看文件名，双击或按Alt+Enter展开播放。表格工具可设置单元格底纹；完整顶栏保留导航与用户入口；斜杠菜单的笔记链接位于最后。客户端下载页另提供移动预览包：Android为内部测试签名、HarmonyOS需签名、iOS仅源工程，不参与桌面自动更新。设置中的AI工具链支持可撤销的SSH客户端令牌，平台升级不撤销仍有效的认证，工具缓存需由客户端刷新。\n`);
if (process.env.ANOTE_RELEASE_CHANNEL === "preview")
  await fs.appendFile(path.join(stage,"README.txt"), "\n此预览包使用独立的 ANote-Preview 配置目录，不自动载入正式客户端的账号、服务器连接或个人目录。默认连接隔离预览服务，请使用测试账号。请从解压目录运行，保留正式客户端原程序。\n");
await fs.appendFile(path.join(stage,"README.txt"),
  "\n协作数据优化：正文可先以只读方式显示，协作恢复完成后进入编辑；已有离线缓存由后台线程整理并保留待同步草稿。服务器已整理的笔记需要兼容客户端，收到升级提示时请更新客户端或刷新网页。\n");
await fs.appendFile(path.join(stage,"README.txt"),
  "\n知识库归档：管理员可在管理知识库中归档或恢复整库。归档后只读，正文、附件、历史与原有阅读授权保留，通过已归档筛选查看。未同步的离线修改作为草稿保留，恢复知识库后可手动合并。桌面本地模式首次归档只升级目录索引，之后该目录需使用新版客户端打开，旧客户端会拒绝载入以保护只读状态。MCP 认证方式保持不变，格式规则以 get_editor_rules 返回为准。\n");
await fs.appendFile(path.join(stage,"README.txt"), "\n表格列宽：编辑时拖动列边界调整；右键单元格或选择行列后，可在表格工具栏使用按内容调整列宽和平均分配列宽。操作保留内容、合并和底纹，支持撤销重做；输入时不会反复重新分配列宽。手机工具栏支持换行和明暗主题。\n");
await fs.appendFile(path.join(stage,"README.txt"), "\n表格与段落：单元格支持顶部、居中、底部对齐；正文支持首行缩进两字符，打印和 PDF 保留。拖动用于选择文字，整格选择请使用按钮或行列选择柄，Shift 扩选。工具栏松开鼠标后显示，不撑动正文。编辑格式为 schema 9；旧客户端需更新。MCP 有效令牌继续使用，刷新工具列表并读取 get_editor_rules 后按新格式生成预览。\n");
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
  applicationName: "ANote",
  version: pkg.version,
  ...(process.env.ANOTE_RELEASE_CHANNEL?{channel:process.env.ANOTE_RELEASE_CHANNEL}:{}),
  electron,
  editorSchema: EDITOR_SCHEMA_VERSION,
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
  legacyPackages: previous?.buildHash === buildHash ? previous.legacyPackages || [] : [],
};
// 0.4.13 validates the old filename, archive root, executable and ASAR
// productName. These hidden bridge builds carry the same ANote application
// code while preserving that complete contract for an unattended data-safe
// transition. Normal downloads and all new updater requests use ANote.
const products = process.env.ANOTE_INCLUDE_LEGACY_BRIDGES === "1" ? ["ANote", "SimpleNote"] : ["ANote"];
for (const productName of products) {
await fs.writeFile(path.join(stage, "package.json"), JSON.stringify({ ...pkg, productName }, null, 2) + "\n");
const packages = productName === "ANote" ? manifest.packages : manifest.legacyPackages;
for (const [platform, arch] of targets) {
  if (
    !["linux", "win32", "darwin"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error("Unsupported target");
  const existing = packages.find(
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
        name: productName,
        executableName: productName,
        icon: path.join(stage, "assets", "anote"),
        extendInfo: { CFBundleDisplayName: "ANote", CFBundleName: "ANote" },
        win32metadata: { CompanyName: "ANote", FileDescription: "ANote", ProductName: "ANote" },
        appBundleId: process.env.ANOTE_RELEASE_CHANNEL === "preview" ? "org.anote.desktop.preview" : "org.anote.desktop",
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
  const filename = `${productName}-${pkg.version}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`,
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
  const existingIndex = packages.findIndex((value) => value.platform === platform && value.arch === arch);
  if (existingIndex >= 0) packages.splice(existingIndex, 1);
  packages.push({
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
}
await fs.writeFile(
  path.join(out, "SHA256SUMS"),
  [...manifest.packages, ...manifest.legacyPackages]
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
    legacyPackages: manifest.legacyPackages.map(({ platform, arch, file, bytes }) => ({ platform, arch, file, bytes })),
  }),
);
