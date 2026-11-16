import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'.',testMatch:'library-archive.spec.ts',workers:1,timeout:90000,expect:{timeout:15000},reporter:[['list'],['json',{outputFile:'../../../artifacts/library-archive/native/results.json'}]],outputDir:'../../../artifacts/library-archive/native/test-results'});
