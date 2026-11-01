import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "./tests",
  testMatch: process.env.PERSISTENCE_ONLY
    ? "persistence.spec.ts"
    : "chain.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL(
            `./artifacts/${process.env.PERSISTENCE_ONLY ? "persistence" : "browser"}-results.json`,
            import.meta.url,
          ),
        ),
      },
    ],
  ],
  outputDir: fileURLToPath(
    new URL("./artifacts/test-results", import.meta.url),
  ),
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:3099",
    viewport: { width: 1500, height: 1200 },
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
