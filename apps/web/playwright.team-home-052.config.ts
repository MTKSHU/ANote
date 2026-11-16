import {defineConfig} from '@playwright/test';
import base from './playwright.config';

export default defineConfig({...base,
  testMatch:['scoped-home.spec.ts'],
  grep:/首页三个分类|团队首页与团队管理首页/,
  reporter:[['list'],['json',{outputFile:process.env.ANOTE_TEAM_HOME_REPORT||'/workspace/artifacts/preview-052/web/team-home-results.json'}]],
  outputDir:process.env.ANOTE_TEAM_HOME_OUTPUT||'/workspace/artifacts/preview-052/web/team-home-test-results',
});
