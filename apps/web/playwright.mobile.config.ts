import {defineConfig,devices} from '@playwright/test';
import base from './playwright.config';
import {fileURLToPath} from 'node:url';

export default defineConfig({...base,
  testMatch:'mobile-workspace.spec.ts',
  projects:[
    {name:'android-chromium',use:{...devices['Pixel 7'],defaultBrowserType:'chromium'}},
    {name:'ios-webkit',use:{...devices['iPhone 13'],defaultBrowserType:'webkit'}},
  ],
  reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../artifacts/preview-050/web/mobile-results.json',import.meta.url))}]],
  outputDir:'../../artifacts/preview-050/web/mobile-results',
});
