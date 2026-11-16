import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'table-width.spec.ts',workers:1,timeout:90000,expect:{timeout:15000},reporter:[['list'],['json',{outputFile:'../../../artifacts/table-width/native/results.json'}]],outputDir:'../../../artifacts/table-width/native/test-results'});
