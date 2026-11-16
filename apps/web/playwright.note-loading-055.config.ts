import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,testMatch:'note-loading-055.spec.ts',reporter:[['list'],['json',{outputFile:'/workspace/artifacts/preview-055/web/loading/results.json'}]],outputDir:'/workspace/artifacts/preview-055/web/loading/test-results'});
