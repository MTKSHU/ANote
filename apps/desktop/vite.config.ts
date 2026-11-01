import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  base: "./",
  plugins: [react()],
  publicDir: fileURLToPath(new URL("../web/public", import.meta.url)),
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ["@tiptap/react", "@tiptap/starter-kit"],
          collaboration: ["yjs", "@hocuspocus/provider", "y-indexeddb"],
        },
      },
    },
  },
});
