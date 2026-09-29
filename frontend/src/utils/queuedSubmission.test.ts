import assert from 'node:assert/strict';
import test from 'node:test';
import { isDefiniteQueueRejection } from './queuedSubmission.ts';

test('network, server, auth and mismatched-key outcomes retain the original frozen queue request', () => {
  for (const error of [{}, { status: 500 }, { status: 502 }, { status: 401 }, { status: 423 },
    { status: 409, code: 'SCHEDULE_KEY_MISMATCH' }, { status: 409 }]) {
    assert.equal(isDefiniteQueueRejection(error), false);
  }
});
test('explicit preflight and version refusals allow correction without inventing a new queued record', () => {
  for (const error of [{ status: 400 }, { status: 413 }, { status: 422 },
    { status: 409, code: 'SCHEDULE_CHANGED' }, { status: 409, code: 'SCHEDULE_QUEUE_FULL' },
    { status: 404, code: 'SCHEDULE_ACCOUNT_MISSING' }]) {
    assert.equal(isDefiniteQueueRejection(error), true);
  }
});
