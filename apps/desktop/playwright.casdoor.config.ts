import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import config from "./playwright.config";
export default defineConfig({
  ...config,
  testMatch: "casdoor.spec.ts",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL(
            "../../artifacts/desktop/casdoor-results.json",
            import.meta.url,
          ),
        ),
      },
    ],
  ],
  outputDir: "../../artifacts/desktop/casdoor-test-results",
});
