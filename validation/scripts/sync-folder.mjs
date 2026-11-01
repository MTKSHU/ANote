import path from "node:path";
import { createWorkspaceSync } from "@anote/sync-core/workspace";
const args = process.argv.slice(2),
  command = args.shift() || "sync",
  options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || !args[i + 1])
    throw new Error(
      "Usage: sync-folder.mjs pull|push|sync|watch --url URL --doc ID --dir DIRECTORY",
    );
  options[args[i].slice(2)] = args[i + 1];
}
const client = createWorkspaceSync({
  serverURL: options.url || process.env.ANOTE_URL || "http://127.0.0.1:3099",
  id: options.doc,
  directory: options.dir || "./local-notes",
  token: process.env.ANOTE_TOKEN,
});
const { pull, push, sync } = client;
async function run() {
  if (command === "pull") return pull();
  if (command === "push") return push();
  if (command === "sync" || command === "watch") return sync();
  throw new Error("未知命令");
}
if (command === "watch") {
  for (;;) {
    try {
      const result = await run();
      if (result.direction !== "unchanged") console.log(JSON.stringify(result));
    } catch (e) {
      console.error(e.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} else {
  try {
    console.log(JSON.stringify(await run()));
  } catch (e) {
    console.error(e.message);
    if (e.data?.conflicts)
      console.error(
        JSON.stringify({
          conflicts: e.data.conflicts.map((c) => ({
            blockId: c.blockId,
            reason: c.reason,
          })),
        }),
      );
    process.exitCode = e.status === 409 ? 2 : 1;
  }
}
