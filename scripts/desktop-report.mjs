import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const results = JSON.parse(
  await fs.readFile("artifacts/desktop/results.json", "utf8"),
);
function specs(suites){return suites.flatMap(suite=>[...(suite.specs||[]),...specs(suite.suites||[])]);}
const names=new Set(specs(results.suites||[]).map(spec=>spec.title));
if (
  names.size!==3||!['真实 Electron：','离线富文本与附件缓存：','原生目录：'].every(prefix=>[...names].some(name=>name.startsWith(prefix)))||
  results.stats.expected !== 3 ||
  results.stats.unexpected ||
  results.stats.skipped ||
  results.stats.flaky
)
  throw new Error("Desktop verification is incomplete");
async function files(directory) {
  const output = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (["dist", "artifacts", "node_modules"].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) output.push(...(await files(file)));
    else if (item.isFile()) output.push(file);
  }
  return output;
}
const sourceHashes = {};
for (const file of [
  ...(await files("packages")),
  ...(await files("apps/desktop")),
  ...(await files("scripts")),
  "package.json",
  "package-lock.json",
].sort())
  sourceHashes[file] = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const electron = JSON.parse(
  await fs.readFile("node_modules/electron/package.json", "utf8"),
).version;
await fs.mkdir("artifacts/reports", { recursive: true });
await fs.writeFile(
  "artifacts/reports/desktop-evidence.json",
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      scope: "Electron shared editor and Markdown workspace",
      desktopScenarios: 3,
      runtime: {
        execution: "Docker containers only",
        platform: "Linux x64",
        electron,
        display: "Xvfb",
        rootTestArgument: "--no-sandbox",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
      limits: [
        "Development client against the isolated validation server, not production authentication",
        "Windows and macOS native operation, signing and installation not verified",
        "Container without OS keyring; tokens remain in memory and reauthentication is required after restart",
        "Markdown structural edits are protected conflicts, not automatic structural merging",
        "Native dialog is stubbed to a real test directory; filesystem and IPC are real",
        "Graceful client restart tested; sudden power loss not proven",
      ],
      sourceHashes,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    desktopScenarios: 3,
    electron,
    evidence: "artifacts/reports/desktop-evidence.json",
  }),
);
