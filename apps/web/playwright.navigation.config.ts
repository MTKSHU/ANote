import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: [
    "trash-navigation.spec.ts",
    "platform-teams.spec.ts",
    "sharing.spec.ts",
  ],
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL(
            "../../artifacts/web/navigation-results.json",
            import.meta.url,
          ),
        ),
      },
    ],
  ],
  outputDir: "../../artifacts/web/navigation-test-results",
});
