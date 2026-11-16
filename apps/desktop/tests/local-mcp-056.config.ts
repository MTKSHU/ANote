import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
export default defineConfig({testDir:'.',testMatch:'local-mcp-056.spec.ts',workers:1,fullyParallel:false,timeout:180000,expect:{timeout:30000},reporter:[['list'],['json',{outputFile:fileURLToPath(new URL('../../../artifacts/ui-local-mcp-056/desktop/results.json',import.meta.url))}]],outputDir:'../../../artifacts/ui-local-mcp-056/desktop/test-results',use:{screenshot:'only-on-failure',trace:'retain-on-failure'}});
