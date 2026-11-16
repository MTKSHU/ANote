import {defineConfig} from "@playwright/test";
const runtime=process.env.PERFORMANCE_RUNTIME||"candidate";
export default defineConfig({
  testDir:".",testMatch:"typing-performance.spec.ts",workers:1,fullyParallel:false,timeout:600000,expect:{timeout:20000},
  reporter:[["list"],["json",{outputFile:`/workspace/artifacts/preview-050/performance/${runtime}-results.json`}]],
  outputDir:`/workspace/artifacts/preview-050/performance/${runtime}-test-results`,
  use:{baseURL:process.env.BASE_URL||"http://anote.internal:3000",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure"},
});
