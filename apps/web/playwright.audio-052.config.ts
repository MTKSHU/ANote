import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({...base,
  testMatch:['lazy-audio-051.spec.ts'],
  grep:/旧 file 标识音频/,
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_AUDIO_REPORT||'/workspace/artifacts/preview-052/web/audio-results.json'}]],
  outputDir:process.env.ANOTE_AUDIO_OUTPUT||'/workspace/artifacts/preview-052/web/audio-test-results',
});
