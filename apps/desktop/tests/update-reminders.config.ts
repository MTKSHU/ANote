import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
const prefix=process.env.DESKTOP_EXECUTABLE?"packaged-":"";
export default defineConfig({
  testDir:".",testMatch:"update-reminders.spec.ts",workers:1,fullyParallel:false,timeout:90000,expect:{timeout:15000},
  reporter:[["list"],["json",{outputFile:fileURLToPath(new URL(`../../../artifacts/desktop/${prefix}update-reminders-results.json`,import.meta.url))}]],
  outputDir:`../../../artifacts/desktop/${prefix}update-reminders-test-results`,
  use:{headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
});
