import {defineConfig} from '@playwright/test';
import assert from 'node:assert/strict';

assert.ok(!process.env.ANOTE_STABLE_VERSION||process.env.ANOTE_STABLE_VERSION==='0.5.3');
assert.ok(!process.env.ANOTE_PREVIOUS_VERSION||process.env.ANOTE_PREVIOUS_VERSION==='0.5.2');
process.env.ANOTE_STABLE_VERSION='0.5.3';
process.env.ANOTE_PREVIOUS_VERSION='0.5.2';
process.env.ANOTE_TEST_VERSION='0.5.3';
process.env.ANOTE_TEST_DESKTOP_VERSION='0.5.3';
process.env.ANOTE_TEST_ARTIFACT_ROOT??='artifacts/stable-053/desktop';
process.env.PREVIEW_PUBLIC_ORIGIN??='http://127.0.0.1:3180';

export default defineConfig({
  testDir:'.',testMatch:['stable-upgrade.spec.ts','lazy-audio-051.spec.ts','offline-team-home-052.spec.ts'],
  workers:1,fullyParallel:false,timeout:300000,expect:{timeout:20000},
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/stable-053/desktop/native-release-results.json'}]],
  outputDir:'/workspace/artifacts/stable-053/desktop/native-release-results',
  use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
