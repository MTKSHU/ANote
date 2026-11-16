import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir:".",testMatch:"workspace-account-menu.spec.ts",workers:1,timeout:30_000,
  reporter:[["list"]],use:{headless:true,viewport:{width:1100,height:900}},
  outputDir:"../../../artifacts/desktop/workspace-account-menu-results",
});
