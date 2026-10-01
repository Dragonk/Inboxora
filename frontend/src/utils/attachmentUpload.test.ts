import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentBatchIssue, attachmentWarningMiB } from './attachmentUpload.ts';

test('the whole drop batch and concurrent reads share one attachment budget', () => {
  const files = [{ name: 'first', size: 6 }, { name: 'second', size: 6 }];
  assert.deepEqual(attachmentBatchIssue(files, 0, 0, { singleAttachmentBytes: 10, totalAttachmentBytes: 10 }), { kind: 'total', name: '', actual: 12, limit: 10 });
  assert.equal(attachmentBatchIssue([{ name: 'f', size: 4 }], 2, 4, { totalAttachmentBytes: 10 }), null);
  assert.equal(attachmentBatchIssue([{ name: 'f', size: 5 }], 2, 4, { totalAttachmentBytes: 10 })?.actual, 11);
  assert.equal(attachmentBatchIssue([{ name: 'large', size: 11 }], 0, 0, { singleAttachmentBytes: 10 })?.kind, 'single');
  assert.equal(attachmentBatchIssue([{ name: 'f', size: 1 }], 0, 0, { totalAttachmentBytes: 0 })?.limit, 0);
});
test('soft warning settings never become the provider limit', () => {
  for (const bad of [null, undefined, '30', -1, 151, .5, Infinity, NaN]) assert.equal(attachmentWarningMiB(bad), 20);
  for (const value of [0, 1, 20, 50, 150]) assert.equal(attachmentWarningMiB(value), value);
  assert.equal(attachmentBatchIssue([{ name: 'f', size: 30 }], 0, 0, { singleAttachmentBytes: 100, totalAttachmentBytes: 100 }), null);
});
