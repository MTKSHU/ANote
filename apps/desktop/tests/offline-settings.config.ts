import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "offline-settings.spec.ts",
  workers: 1,
  timeout: 30_000,
  use: { headless: true, viewport: { width: 1100, height: 1000 } },
});
