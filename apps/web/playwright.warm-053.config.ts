import {defineConfig} from '@playwright/test';
import base from './playwright.config';
const label=process.env.ANOTE_WARM_LABEL||'candidate';
export default defineConfig({...base,testMatch:['warm-document-053.spec.ts'],timeout:180000,reporter:[['list'],['json',{outputFile:`/workspace/artifacts/preview-053/web/${label}/results.json`}]],outputDir:`/workspace/artifacts/preview-053/web/${label}/test-results`});
