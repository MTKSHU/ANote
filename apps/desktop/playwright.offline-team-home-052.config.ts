import {defineConfig} from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({...base,
  testMatch:["offline-team-home-052.spec.ts"],
  reporter:[["list"],["json",{outputFile:process.env.ANOTE_OFFLINE_TEAM_HOME_REPORT||"/workspace/artifacts/preview-052/desktop/offline-team-home-results.json"}]],
  outputDir:process.env.ANOTE_OFFLINE_TEAM_HOME_OUTPUT||"/workspace/artifacts/preview-052/desktop/offline-team-home-test-results",
});
