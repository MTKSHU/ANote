import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch:['banner-table-051.spec.ts','table-controls.spec.ts','scoped-home.spec.ts','compact-account.spec.ts','navigation-sharing.spec.ts'],
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_UI_REPORT||'/workspace/artifacts/feature-051/web/banner-table-results.json'}]],
  outputDir:process.env.ANOTE_UI_OUTPUT||'/workspace/artifacts/feature-051/web/banner-table-results',
});
