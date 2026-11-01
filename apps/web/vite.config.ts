import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          editor: [
            "@tiptap/react",
            "@tiptap/starter-kit",
            "@tiptap/extension-table",
          ],
          collaboration: ["yjs", "@hocuspocus/provider", "y-indexeddb"],
        },
      },
    },
  },
});
