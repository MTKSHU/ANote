import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
export default defineConfig({testDir:'.',testMatch:['document-preview-054.spec.ts','document-ui-055.spec.ts'],workers:1,fullyParallel:false,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../../artifacts/note-ui-055/desktop/results.json',import.meta.url))}]],outputDir:'../../../artifacts/note-ui-055/desktop/test-results',use:{baseURL:process.env.BASE_URL||'http://anote.internal:3000',screenshot:'only-on-failure',trace:'retain-on-failure'}});
