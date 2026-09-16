import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposeBodyIsHtml, shouldShowSignatureEditor } from './composeFormat.ts';

test('a persisted draft format wins over later plaintext preferences', () => {
  assert.equal(resolveComposeBodyIsHtml(true, true), true);
  assert.equal(resolveComposeBodyIsHtml(true, false), true);
  assert.equal(resolveComposeBodyIsHtml(false, true), false);
  assert.equal(resolveComposeBodyIsHtml(false, false), false);
  assert.equal(resolveComposeBodyIsHtml(undefined, true), false);
  assert.equal(resolveComposeBodyIsHtml(undefined, false), true);
});

test('a saved signature remains visible even after its account default is removed', () => {
  assert.equal(shouldShowSignatureEditor(null, true), true);
  assert.equal(shouldShowSignatureEditor(null, false), false);
  assert.equal(shouldShowSignatureEditor('<p>default</p>', false), true);
});
