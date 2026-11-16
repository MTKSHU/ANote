import test from 'node:test';
import assert from 'node:assert/strict';
import {fitColumnWidths} from '../../apps/desktop/renderer/table-widths.ts';

test('table content fit keeps short columns compact and long columns within the available width',()=>{
  assert.deepEqual(fitColumnWidths([64,72,90],800),[64,72,90]);
  const widths=fitColumnWidths([80,1600,90],800);
  assert.equal(widths[0],80);assert.equal(widths[2],90);
  assert.equal(widths.reduce((a,b)=>a+b,0),800);assert(widths[1]>widths[0]*3);assert(widths.every(w=>Number.isInteger(w)&&w>=48));
  assert.deepEqual(fitColumnWidths([80,1600,90],800),widths);
});
test('narrow tables retain readable minimums and equal allocation rounds without overflowing',()=>{
  assert.deepEqual(fitColumnWidths([200,400,50],120),[48,48,48]);
  const equal=fitColumnWidths([500,500,500],899);assert.equal(equal.reduce((a,b)=>a+b,0),899);assert(Math.max(...equal)-Math.min(...equal)<=1);
  assert.deepEqual(fitColumnWidths([],400),[]);assert.deepEqual(fitColumnWidths([NaN,Infinity,-1],400),[48,48,48]);
});
