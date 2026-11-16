import {defineConfig} from '@playwright/test';
import assert from 'node:assert/strict';

assert.ok(!process.env.ANOTE_TEST_VERSION||process.env.ANOTE_TEST_VERSION==='0.5.2');
process.env.ANOTE_TEST_VERSION='0.5.2';
process.env.ANOTE_TEST_ARTIFACT_ROOT??='artifacts/preview-052/desktop';
process.env.PREVIEW_PUBLIC_ORIGIN??='http://127.0.0.1:3170';

export default defineConfig({
  testDir:'.',testMatch:'lazy-audio-051.spec.ts',workers:1,fullyParallel:false,
  timeout:180000,expect:{timeout:20000},
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/preview-052/desktop/media-results.json'}]],
  outputDir:'/workspace/artifacts/preview-052/desktop/media-test-results',
  use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
