import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

const read = () => readFile(new URL('./DeleteResourceDialog.tsx', import.meta.url), 'utf8');

describe('delete resource dialog', () => {
  it('passes the resource name to the confirmation translation', async () => {
    const source = await read();
    assert.match(source, /t\('accountUi\.confirmName', \{ name \}\)/);
    assert.doesNotMatch(source, /t\('accountUi\.confirmName'\)\s*<input/);
  });
});
