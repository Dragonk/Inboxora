import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventGeometryForDay, layoutTimedEvents, workHoursGeometry } from './calendarView.js';

const day = new Date(2026, 8, 3);
const event = (id, start, end, allDay = false) => ({ id, starts_at: start, ends_at: end, all_day: allDay });

test('calculates local geometry at midnight and through the end of day', () => {
  assert.deepEqual(eventGeometryForDay(event('midnight', '2026-09-03T00:00:00', '2026-09-03T01:00:00'), day), { start: 0, end: 60 });
  assert.deepEqual(eventGeometryForDay(event('late', '2026-09-03T23:00:00', '2026-09-04T00:00:00'), day), { start: 1380, end: 1440 });
  assert.deepEqual(eventGeometryForDay(event('explicit-end', '2026-09-03T23:00:00', '2026-09-03T24:00'), day), { start: 1380, end: 1440 });
});

test('separates all-day events from timed geometry', () => {
  assert.equal(eventGeometryForDay(event('all-day', '2026-09-03', '2026-09-04', true), day), null);
});

test('assigns intersecting timed events readable columns', () => {
  const laidOut = layoutTimedEvents([
    event('a', '2026-09-03T09:00:00', '2026-09-03T11:00:00'),
    event('b', '2026-09-03T10:00:00', '2026-09-03T12:00:00'),
    event('c', '2026-09-03T11:00:00', '2026-09-03T13:00:00'),
  ], day);
  assert.deepEqual(laidOut.map(item => [item.event.id, item.column, item.columns]), [['a', 0, 2], ['b', 1, 2], ['c', 0, 2]]);
});

test('calculates the visible working-hours boundary within the day', () => {
  assert.deepEqual(workHoursGeometry('09:00', '17:00'), { start: 540, end: 1020 });
  assert.deepEqual(workHoursGeometry('23:00', '24:00'), { start: 1380, end: 1440 });
});
