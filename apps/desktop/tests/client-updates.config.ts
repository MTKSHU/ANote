import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:".",testMatch:"client-updates.spec.ts",workers:1,timeout:30000,outputDir:"../../../artifacts/desktop/client-updates-ui",use:{headless:true,viewport:{width:1200,height:1000}},reporter:[["list"]]});
