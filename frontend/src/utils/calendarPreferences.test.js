import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CALENDAR_PREFERENCES,
  normalizeCalendarWorkDays,
  normalizeCalendarWorkTime,
} from './calendarPreferences.js';

test('calendar preferences expose weekday 9-to-5 defaults', () => {
  assert.deepEqual(DEFAULT_CALENDAR_PREFERENCES, {
    calendarWorkDays: [1, 2, 3, 4, 5],
    calendarWorkHoursStart: '09:00',
    calendarWorkHoursEnd: '17:00',
  });
});

test('calendar work days normalize invalid and duplicate values', () => {
  assert.deepEqual(normalizeCalendarWorkDays([5, 1, 1, 0, 7, '2', null]), [0, 1, 5]);
  assert.deepEqual(normalizeCalendarWorkDays([]), [1, 2, 3, 4, 5]);
});

test('calendar work times accept HH:mm and fall back safely', () => {
  assert.equal(normalizeCalendarWorkTime('08:30'), '08:30');
  assert.equal(normalizeCalendarWorkTime('8:30'), '09:00');
  assert.equal(normalizeCalendarWorkTime('25:00'), '09:00');
});
