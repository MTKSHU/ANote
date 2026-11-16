import {defineConfig} from '@playwright/test';
import base from './playwright.position-migration.config';

// The original annotation/IME cases already passed in the first report.
// Retry only the new structural cases after rebuilding the model fix, plus
// the paragraph-control cases affected by the final render-state bailout.
export default defineConfig({...base,
  testMatch:['position-migration-051.spec.ts','paragraph-format.spec.ts'],
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_MIGRATION_REPORT||'/workspace/artifacts/preview-051/web/position-migration-retry-results.json'}]],
  outputDir:process.env.ANOTE_MIGRATION_OUTPUT||'/workspace/artifacts/preview-051/web/position-migration-retry-results',
});
