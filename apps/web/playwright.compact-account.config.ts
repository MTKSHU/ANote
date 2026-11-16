import {defineConfig} from "@playwright/test";
import config from "./playwright.config";
export default defineConfig({...config,testMatch:"compact-account.spec.ts",timeout:120000,reporter:[["list"],["json",{outputFile:"/workspace/artifacts/web/compact-account-results.json"}]],outputDir:"/workspace/artifacts/web/compact-account"});
