import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScheduleTime, scheduleWallTime, schedulePreview } from './scheduleTime.ts';

test('exact zoned future time yields UTC instant and offset preview', () => {
  assert.deepEqual(resolveScheduleTime('2030-07-01T10:30', 'Europe/Warsaw', 0), { instant: '2030-07-01T08:30:00.000Z' });
  assert.equal(scheduleWallTime('2030-07-01T08:30:00Z', 'Europe/Warsaw'), '2030-07-01T10:30');
  assert.match(schedulePreview('2030-07-01T08:30:00Z', 'Europe/Warsaw', 'en'), /GMT\+02:00/);
});
test('DST gaps and repeated hours never silently shift', () => {
  assert.deepEqual(resolveScheduleTime('2030-03-10T02:30', 'America/New_York', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2030-11-03T01:30', 'America/New_York', 0), { error: 'ambiguousTime' });
  assert.deepEqual(resolveScheduleTime('2030-04-07T01:45', 'Australia/Lord_Howe', 0), { error: 'ambiguousTime' });
  assert.deepEqual(resolveScheduleTime('2030-10-06T02:15', 'Australia/Lord_Howe', 0), { error: 'invalidTime' });
});
test('invalid dates, invalid zones and past times reject', () => {
  assert.deepEqual(resolveScheduleTime('2030-02-30T12:00', 'UTC', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2030-02-01T12:00', 'Not/A_Zone', 0), { error: 'invalidTime' });
  assert.deepEqual(resolveScheduleTime('2000-02-01T12:00', 'UTC'), { error: 'pastTime' });
});
