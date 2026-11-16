import {defineConfig} from '@playwright/test';

// Release channel and profile compatibility are tested against actual ASAR
// applications. Business data is created only in the isolated preview API.
export default defineConfig({
  testDir:'.',
  testMatch:['stable-upgrade.spec.ts','backup-history.spec.ts','incremental-backup.spec.ts'],
  workers:1,fullyParallel:false,timeout:240000,expect:{timeout:20000},
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/stable-050/desktop/native-release-results.json'}]],
  outputDir:'/workspace/artifacts/stable-050/desktop/native-release-results',
  use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
