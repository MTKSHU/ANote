import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({...base,
  testMatch:['mcp-personal-tokens.spec.ts','mcp-schema-contract.spec.ts','mcp.spec.ts','settings-entries.spec.ts'],
  reporter:[['list'],['json',{outputFile:'/workspace/artifacts/preview-051/mcp/results.json'}]],
  outputDir:'/workspace/artifacts/preview-051/mcp/test-results',
});
