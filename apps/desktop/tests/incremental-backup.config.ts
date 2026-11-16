import {defineConfig} from "@playwright/test";
const prefix=process.env.DESKTOP_EXECUTABLE?"packaged-":"";
export default defineConfig({
  testDir:".",testMatch:"incremental-backup.spec.ts",workers:1,fullyParallel:false,timeout:180000,expect:{timeout:20000},
  reporter:[["list"],["json",{outputFile:`/workspace/artifacts/desktop/${prefix}incremental-backup-results.json`}]],
  outputDir:`/workspace/artifacts/desktop/${prefix}incremental-backup-test-results`,
  use:{baseURL:process.env.BASE_URL||"http://anote.internal:3000",screenshot:"only-on-failure",trace:"retain-on-failure"},
});
