import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: ["team-casdoor.spec.ts", "oidc-discovery.spec.ts"],
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: fileURLToPath(
          new URL(
            "../../artifacts/web/discovery-results.json",
            import.meta.url,
          ),
        ),
      },
    ],
  ],
  outputDir: "../../artifacts/web/discovery-test-results",
});
