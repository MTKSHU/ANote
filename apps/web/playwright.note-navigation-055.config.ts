import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,testMatch:['note-navigation-055.spec.ts'],reporter:[['list'],['json',{outputFile:'../../artifacts/preview-055/web/navigation-results.json'}]],outputDir:'../../artifacts/preview-055/web/navigation-test-results'});
