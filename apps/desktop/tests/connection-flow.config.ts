import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
export default defineConfig({
  testDir:".",testMatch:"connection-flow.spec.ts",workers:1,fullyParallel:false,timeout:120000,expect:{timeout:15000},
  reporter:[["list"],["json",{outputFile:fileURLToPath(new URL(`../../../artifacts/desktop/${process.env.DESKTOP_EXECUTABLE?"packaged-":""}connection-results.json`,import.meta.url))}]],
  outputDir:`../../../artifacts/desktop/${process.env.DESKTOP_EXECUTABLE?"packaged-":""}connection-test-results`,
  use:{baseURL:process.env.BASE_URL||"http://anote.internal:3000",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
});
