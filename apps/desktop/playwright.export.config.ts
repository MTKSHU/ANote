import {defineConfig} from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({...base,testMatch:"note-export.spec.ts",reporter:[["list"],["json",{outputFile:"/workspace/artifacts/desktop/note-export-results.json"}]],outputDir:"/workspace/artifacts/desktop/note-export-test-results"});
