import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({...base,
  testMatch:['position-migration-051.spec.ts','annotations.spec.ts'],
  timeout:120000,
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_MIGRATION_REPORT||'/workspace/artifacts/preview-051/web/position-migration-results.json'}]],
  outputDir:process.env.ANOTE_MIGRATION_OUTPUT||'/workspace/artifacts/preview-051/web/position-migration-results',
});
