import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposeBodyIsHtml, shouldIncludeSignatureOverride, shouldShowSignatureEditor } from './composeFormat.ts';

test('a persisted draft format wins over later plaintext preferences', () => {
  assert.equal(resolveComposeBodyIsHtml(true, true), true);
  assert.equal(resolveComposeBodyIsHtml(true, false), true);
  assert.equal(resolveComposeBodyIsHtml(false, true), false);
  assert.equal(resolveComposeBodyIsHtml(false, false), false);
  assert.equal(resolveComposeBodyIsHtml(undefined, true), false);
  assert.equal(resolveComposeBodyIsHtml(undefined, false), true);
});

test('includes a newly typed plaintext signature without a default or rich ref', () => {
  assert.equal(shouldIncludeSignatureOverride('DOPISANY_PODPIS', true, null), true);
  assert.equal(shouldIncludeSignatureOverride('', true, null), true);
  assert.equal(shouldIncludeSignatureOverride('', false, null), false);
});

test('a saved signature remains visible even after its account default is removed', () => {
  assert.equal(shouldShowSignatureEditor(null, true), true);
  assert.equal(shouldShowSignatureEditor(null, false), false);
  assert.equal(shouldShowSignatureEditor('<p>default</p>', false), true);
});
