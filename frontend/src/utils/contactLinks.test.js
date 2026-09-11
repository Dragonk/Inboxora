import test from 'node:test';
import assert from 'node:assert/strict';
import { safeHttpUrl } from './contactLinks.js';

test('safeHttpUrl permits absolute HTTP(S) links only', () => {
  assert.equal(safeHttpUrl('https://example.test/path'), 'https://example.test/path');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('matrix:@ada:example.test'), null);
  assert.equal(safeHttpUrl('not a URL'), null);
});
