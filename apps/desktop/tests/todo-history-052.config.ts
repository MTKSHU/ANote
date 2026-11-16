import {defineConfig} from "@playwright/test";
const label=process.env.TODO_RUN_LABEL||"candidate";
export default defineConfig({testDir:".",testMatch:"todo-history-052.spec.ts",workers:1,fullyParallel:false,timeout:420000,expect:{timeout:30000},reporter:[["list"],["json",{outputFile:`/workspace/artifacts/preview-052/desktop/todo-${label}-results.json`}]],outputDir:`/workspace/artifacts/preview-052/desktop/todo-${label}-test-results`,use:{baseURL:process.env.BASE_URL||"http://anote.internal:3000",screenshot:"only-on-failure",trace:"retain-on-failure"}});
