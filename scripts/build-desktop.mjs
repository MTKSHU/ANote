import { build } from "esbuild";
import fs from "node:fs/promises";
await fs.mkdir("apps/desktop/dist", { recursive: true });
await fs.rm("apps/desktop/dist/main.mjs", { force: true });
await fs.rm("apps/desktop/dist/main.mjs.map", { force: true });
await build({
  entryPoints: ["apps/desktop/main/main.mjs"],
  outfile: "apps/desktop/dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  define: {
    ANOTE_DEFAULT_SERVER_URL: JSON.stringify(process.env.VITE_ANOTE_SERVER_URL || ""),
    ANOTE_BUILD_CHANNEL: JSON.stringify(process.env.ANOTE_RELEASE_CHANNEL || "stable"),
  },
  sourcemap: true,
});
await build({
  entryPoints:["apps/desktop/main/backup-worker.mjs"],
  outfile:"apps/desktop/dist/backup-worker.cjs",
  bundle:true,platform:"node",format:"cjs",target:"node22",sourcemap:true,
});
await build({
  entryPoints:["apps/desktop/main/document-worker.mjs"],
  outfile:"apps/desktop/dist/document-worker.cjs",
  bundle:true,platform:"node",format:"cjs",target:"node22",sourcemap:true,
});
await fs.copyFile(
  "apps/desktop/main/preload.cjs",
  "apps/desktop/dist/preload.cjs",
);
await build({entryPoints:['apps/desktop/main/local-mcp-worker.mjs'],outfile:'apps/desktop/dist/local-mcp-worker.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',sourcemap:true});
