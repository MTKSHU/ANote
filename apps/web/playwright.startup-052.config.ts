import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({...base,
  testMatch:['startup-performance-052.spec.ts'],timeout:180000,
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_STARTUP_REPORT||'/workspace/artifacts/preview-052/web/startup-results.json'}]],
  outputDir:process.env.ANOTE_STARTUP_OUTPUT||'/workspace/artifacts/preview-052/web/startup-test-results',
});
