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
  sourcemap: true,
});
await fs.copyFile(
  "apps/desktop/main/preload.cjs",
  "apps/desktop/dist/preload.cjs",
);
