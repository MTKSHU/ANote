import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
export default defineConfig({testDir:'.',testMatch:['library-archive.spec.ts','local-mcp-056.spec.ts','markdown-assets-057.spec.ts'],workers:1,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../../artifacts/release-058/desktop/results.json',import.meta.url))}]],outputDir:'../../../artifacts/release-058/desktop/test-results'});
