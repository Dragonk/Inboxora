import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { env, execPath } from 'node:process';
import { test } from 'node:test';
import { eventGeometryForDay, layoutTimedEvents, workHoursGeometry } from './calendarView.js';

const day = new Date(2026, 8, 3);
const event = (id, start, end, allDay = false) => ({ id, starts_at: start, ends_at: end, all_day: allDay });

test('calculates local geometry at midnight and through the end of day', () => {
  assert.deepEqual(eventGeometryForDay(event('midnight', '2026-09-03T00:00:00', '2026-09-03T01:00:00'), day), { start: 0, end: 60 });
  assert.deepEqual(eventGeometryForDay(event('late', '2026-09-03T23:00:00', '2026-09-04T00:00:00'), day), { start: 1380, end: 1440 });
  assert.deepEqual(eventGeometryForDay(event('explicit-end', '2026-09-03T23:00:00', '2026-09-03T24:00'), day), { start: 1380, end: 1440 });
});

test('keeps explicit UTC and offset 24:00 endpoints in their declared instant', () => {
  const source = `import { eventGeometryForDay, eventsForDay } from './src/components/calendarView.js';
const event = (start, end) => ({ starts_at: start, ends_at: end });
const day = new Date(2026, 8, 3);
console.log(JSON.stringify([
  [eventsForDay([event('2026-09-03T23:00:00Z', '2026-09-03T24:00Z')], day).length, eventGeometryForDay(event('2026-09-03T23:00:00Z', '2026-09-03T24:00Z'), day)],
  eventGeometryForDay(event('2026-09-03T23:00:00Z', '2026-09-03T24:00:00Z'), day),
  eventGeometryForDay(event('2026-09-03T23:00:00Z', '2026-09-04T00:00:00.000+00:00'), day),
  [eventsForDay([event('2026-09-04T03:00:00Z', '2026-09-03T24:00:00.500-04:00')], day).length, eventGeometryForDay(event('2026-09-04T03:00:00Z', '2026-09-03T24:00:00.500-04:00'), day)],
]));`;
  const output = execFileSync(execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('../..', import.meta.url), env: { ...env, TZ: 'America/New_York' }, encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(output), [
    [1, { start: 1140, end: 1200 }], { start: 1140, end: 1200 },
    { start: 1140, end: 1200 }, [1, { start: 1380, end: 1440 }],
  ]);
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
