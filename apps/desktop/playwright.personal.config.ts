import { defineConfig } from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "personal.spec.ts",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `/workspace/artifacts/desktop/personal${process.env.PERSONAL_PACKAGED === "1" ? "-packaged" : ""}-results.json`,
      },
    ],
  ],
  outputDir: `/workspace/artifacts/desktop/personal${process.env.PERSONAL_PACKAGED === "1" ? "-packaged" : ""}-test-results`,
});
