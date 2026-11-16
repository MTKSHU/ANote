import {defineConfig} from '@playwright/test';
const label=process.env.ANOTE_WARM_LABEL||'candidate';
export default defineConfig({testDir:'.',testMatch:'warm-document-053.spec.ts',workers:1,timeout:240000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:`/workspace/artifacts/preview-053/desktop/${label}/results.json`}]],outputDir:`/workspace/artifacts/preview-053/desktop/${label}/test-results`,use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'}});
