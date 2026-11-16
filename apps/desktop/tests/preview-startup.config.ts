import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'preview-startup.spec.ts',workers:1,fullyParallel:false,timeout:90000,expect:{timeout:20000},
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/preview-050/desktop/preview-startup-results.json'}]],
  outputDir:'/workspace/artifacts/preview-050/desktop/preview-startup-results',
  use:{screenshot:'only-on-failure',trace:'retain-on-failure'},
});
