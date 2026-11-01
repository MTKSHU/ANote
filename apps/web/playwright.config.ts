import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL("../../artifacts/web/results.json", import.meta.url),
        ),
      },
    ],
  ],
  outputDir: "../../artifacts/web/test-results",
  use: {
    locale: "zh-CN",
    baseURL: process.env.BASE_URL || "http://anote.internal:3000",
    viewport: { width: 1580, height: 1150 },
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
