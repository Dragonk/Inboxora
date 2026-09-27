import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePrefetchInput } from './mailPrefetch.ts';
test('administrator input accepts only whole numbers in the server-supported 0-100 range',()=>{
  for(const value of ['0','1','20','25','30','100'])assert.equal(parsePrefetchInput(value),Number(value));
  for(const value of ['','-1','101','25.5','25x',' 25','25 ','1e2','00','1000'])assert.equal(parsePrefetchInput(value),null);
});
