import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: "./tests",
  testMatch:
    process.env.PACKAGED_CLIENT === "1"
      ? "package.spec.ts"
      : process.env.FORMAL_API === "1"
        ? "formal.spec.ts"
        : "desktop.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL(
            `../../artifacts/desktop/${process.env.PACKAGED_CLIENT === "1" ? "packaged-" : process.env.FORMAL_API === "1" ? "formal-" : ""}results.json`,
            import.meta.url,
          ),
        ),
      },
    ],
  ],
  outputDir: `../../artifacts/desktop/${process.env.PACKAGED_CLIENT === "1" ? "packaged-" : process.env.FORMAL_API === "1" ? "formal-" : ""}test-results`,
  use: {
    baseURL: process.env.BASE_URL || "http://anote-validation.internal:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
