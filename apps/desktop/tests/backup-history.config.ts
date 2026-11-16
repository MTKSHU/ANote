import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:['backup-history.spec.ts','incremental-backup.spec.ts'],workers:1,fullyParallel:false,timeout:240000,expect:{timeout:20000},
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/preview-050/desktop/backup-regression-results.json'}]],
  outputDir:'/workspace/artifacts/preview-050/desktop/backup-regression-results',
  use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
