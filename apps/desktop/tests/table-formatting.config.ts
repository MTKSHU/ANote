import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:['table-formatting.spec.ts','table-width.spec.ts','local-mcp-056.spec.ts'],workers:1,timeout:150000,expect:{timeout:20000},reporter:[['list'],['json',{outputFile:'../../../artifacts/table-paragraph/desktop/results.json'}]],outputDir:'../../../artifacts/table-paragraph/desktop/test-results'});
