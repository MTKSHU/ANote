import {defineConfig} from "@playwright/test";
import {fileURLToPath} from "node:url";
const prefix=process.env.DESKTOP_EXECUTABLE?"packaged-":"";
export default defineConfig({
  testDir:".",testMatch:"compact-account-native.spec.ts",workers:1,fullyParallel:false,timeout:120000,expect:{timeout:20000},
  reporter:[["list"],["json",{outputFile:fileURLToPath(new URL(`../../../artifacts/desktop/${prefix}compact-account-native-results.json`,import.meta.url))}]],
  outputDir:`../../../artifacts/desktop/${prefix}compact-account-native-test-results`,
  use:{baseURL:process.env.BASE_URL||"http://anote.internal:3000",headless:true,trace:"retain-on-failure"},
});
