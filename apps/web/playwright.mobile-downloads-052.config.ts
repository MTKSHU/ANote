import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({ ...base, testMatch: ["clients.spec.ts", "mobile-downloads-052.spec.ts"], reporter: [["list"], ["json", { outputFile: process.env.ANOTE_MOBILE_DOWNLOAD_REPORT || "/workspace/artifacts/preview-052/web/mobile-downloads-results.json" }]], outputDir: process.env.ANOTE_MOBILE_DOWNLOAD_OUTPUT || "/workspace/artifacts/preview-052/web/mobile-downloads-test-results" });
