import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaDays, calendarVisibleRange, shiftCalendarAnchor, sortedDayEvents } from './calendarView.js';

test('month fetch includes all 42 visible days while agenda covers exactly its month', () => {
  const anchor = new Date(2026, 8, 10);
  const grid = calendarVisibleRange(anchor, 'month', 1);
  const agenda = calendarVisibleRange(anchor, 'agenda', 1);
  assert.deepEqual([grid.start.getMonth(), grid.start.getDate(), grid.end.getMonth(), grid.end.getDate()], [7, 31, 9, 12]);
  assert.deepEqual([agenda.start.getMonth(), agenda.start.getDate(), agenda.end.getMonth(), agenda.end.getDate()], [8, 1, 9, 1]);
  assert.equal(calendarVisibleRange(anchor, 'month', 0).start.getDay(), 0);
});

test('agenda navigation clamps dates through month and year boundaries', () => {
  const next = shiftCalendarAnchor(new Date(2026, 0, 31), 'agenda', 1);
  assert.equal(next.getMonth(), 1); assert.equal(next.getDate(), 28);
  assert.equal(shiftCalendarAnchor(new Date(2026, 11, 31), 'agenda', 1).getFullYear(), 2027);
});

test('agendas use end-exclusive multi-day membership and put all-day events before timed entries', () => {
  const allDay = { id: 'all', all_day: true, starts_at: '2026-09-10', ends_at: '2026-09-12' };
  const later = { id: 'late', starts_at: new Date(2026, 8, 10, 14).toISOString(), ends_at: new Date(2026, 8, 10, 15).toISOString() };
  const earlier = { id: 'early', starts_at: new Date(2026, 8, 10, 9).toISOString(), ends_at: new Date(2026, 8, 10, 10).toISOString() };
  const events = [later, allDay, earlier];
  assert.deepEqual(sortedDayEvents(events, new Date(2026, 8, 10)).map(event => event.id), ['all', 'early', 'late']);
  assert.deepEqual(agendaDays(events, new Date(2026, 8, 1)).map(group => [group.day.getDate(), group.events.length]), [[10, 3], [11, 1]]);
  assert.deepEqual(agendaDays(events, new Date(2026, 9, 1)), []);
  assert.equal(events[0], later, 'presentation must not mutate fetched data');
});
