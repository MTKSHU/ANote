import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:['language.spec.ts','table-formatting.spec.ts','table-width.spec.ts','local-mcp-056.spec.ts'],workers:1,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:'../../../artifacts/sync-0510/desktop/results.json'}]],outputDir:'../../../artifacts/sync-0510/desktop/test-results'});
