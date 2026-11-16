import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
export default defineConfig({testDir:'.',testMatch:'markdown-assets-057.spec.ts',workers:1,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../../artifacts/note-layout-057/markdown-desktop/results.json',import.meta.url))}]],outputDir:'../../../artifacts/note-layout-057/markdown-desktop/test-results',use:{screenshot:'only-on-failure',trace:'retain-on-failure'}});
