import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:['table-formatting.spec.ts','table-width.spec.ts','local-mcp-056.spec.ts'],workers:1,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:'../../../artifacts/release-0510/desktop/results.json'}]],outputDir:'../../../artifacts/release-0510/desktop/test-results'});
