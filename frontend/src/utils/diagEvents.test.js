import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordDiagEvent, getDiagEvents, _resetDiagEvents } from './diagEvents.js';

describe('diagEvents', () => {
  it('records events with a timestamp and returns a copy', () => {
    _resetDiagEvents();
    recordDiagEvent({ category: 'ws', type: 'reconnect' });
    recordDiagEvent({ category: 'unread', cause: 'exists_hint', accountId: 'a1', delta: 1 });
    const evs = getDiagEvents();
    assert.equal(evs.length, 2);
    assert.equal(evs[0].category, 'ws');
    assert.ok(evs[0].t);
    assert.equal(evs[1].accountId, 'a1');
    evs.push({}); // mutating the returned array must not affect the ring
    assert.equal(getDiagEvents().length, 2);
  });

  it('ignores non-object entries', () => {
    _resetDiagEvents();
    recordDiagEvent(null);
    recordDiagEvent('x');
    assert.equal(getDiagEvents().length, 0);
  });
});
