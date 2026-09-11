import { it } from 'node:test';
import assert from 'node:assert/strict';
import { calendarSyncWarning } from './calendarSyncWarning.js';
it('summarizes legacy long import warnings and limits visible diagnostic data', () => {
  const value = Array.from({ length: 100 }, (_, i) => `id-${i}: unsupported or malformed VEVENT`).join('; ');
  const result = calendarSyncWarning(value);
  assert.equal(result.count, 100);
  assert.equal(result.details.split('\n').length, 3);
});
it('handles structured warnings and malformed optional samples', () => {
  assert.deepEqual(calendarSyncWarning(JSON.stringify({ code: 'unsupported_events', count: 2, samples: 'bad' })), { count: 2, details: '' });
  assert.equal(calendarSyncWarning(JSON.stringify({ code: 'unsupported_events', count: 2, samples: [{ uid: 'a', reason: 'invalid' }] })).details, 'a: invalid');
});
it('keeps connection errors distinct from partially imported events', () => {
  assert.deepEqual(calendarSyncWarning('Remote calendar request failed (401)'), { count: 0, details: 'Remote calendar request failed (401)' });
  assert.equal(calendarSyncWarning(null), null);
});
