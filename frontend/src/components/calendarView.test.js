import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eventPayload, eventsForDay, monthRange } from './calendarView.js';

describe('calendar desktop helpers', () => {
  it('returns an exclusive month range', () => {
    const { start, end } = monthRange(new Date(2026, 8, 14));
    assert.deepEqual([start.getFullYear(), start.getMonth(), start.getDate()], [2026, 8, 1]);
    assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate()], [2026, 9, 1]);
  });
  it('rejects invalid event ranges before calling the API', () => {
    assert.equal(eventPayload({ calendarId: 'one', startsAt: '2026-09-10T10:00', endsAt: '2026-09-10T09:00', summary: '', description: '', location: '', url: '', organizer: '' }), null);
  });
  it('includes events overlapping a day, including multi-day events', () => {
    assert.equal(eventsForDay([{ starts_at: '2026-09-10T22:00:00.000Z', ends_at: '2026-09-11T02:00:00.000Z' }], new Date(2026, 8, 11)).length, 1);
  });
});
